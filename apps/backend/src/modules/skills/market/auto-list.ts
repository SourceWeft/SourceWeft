import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { SkillListingQueueReason } from "@sourceweft/contracts";
import { db, skillDefinitions, skillVersions } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import {
  changelogVersion,
  diffSkillVersions,
  type SkillVersionChangelog,
} from "./changelog";
import {
  listSkillPublicly,
  prepareSkillListing,
  SKILL_AUTO_LIST_ACTOR,
} from "./listing";

/**
 * A skill whose scan came back clean goes public on its own.
 *
 * The signal is already in the data: ingest triage publishes a clean version
 * and leaves a flagged one as a `draft` for review (`registry/guard.ts`). So
 * "has a published current version" *is* "passed the scan", and this pass needs
 * no hook in the ingest pipeline — it just looks for skills in that state that
 * are not public yet.
 *
 * "Clean" means no flags at all, not merely "published". Some flags are
 * advisory (`binary:executable`, `registry/scan.ts`): they no longer hold a
 * version back, so the person who imported the skill can use it straight away —
 * on the understanding that showing it to OTHER people stays an admin's call,
 * made with the flag in front of them. A published version that carries a flag
 * therefore waits in the listing queue below instead of listing itself.
 */

/**
 * How long a freshly published version waits before it lists itself. Someone
 * who imported a skill for their own use needs a moment to say "keep it
 * private" (`setOwnerSkillListing`); without this the pass could publish it
 * seconds after the import finished.
 */
const AUTO_LIST_GRACE_MINUTES = 10;

/** Most skills listed in one pass; the rest wait for the next tick. */
const AUTO_LIST_BATCH_SIZE = 200;

const currentVersionFlags = sql`coalesce(${skillVersions.manifestJson}->'registry'->'scan'->'flags', '[]'::jsonb)`;

function publishedCurrentVersion(
  flags: "none" | "some",
  options: { settled?: boolean } = {},
) {
  const settled = options.settled
    ? sql`and ${skillVersions.publishedAt} <= now() - make_interval(mins => ${AUTO_LIST_GRACE_MINUTES})`
    : sql``;
  return sql`exists (
    select 1 from ${skillVersions}
    where ${skillVersions.skillId} = ${skillDefinitions.id}
      and ${skillVersions.isCurrent} = true
      and ${skillVersions.status} = 'published'
      and ${skillVersions.manifestJson}->>'listing' is distinct from 'hidden'
      and ${skillVersions.manifestJson}->'registry'->'provenance' is not null
      and jsonb_array_length(${currentVersionFlags}) ${flags === "none" ? sql`= 0` : sql`> 0`}
      ${settled}
  )`;
}

/**
 * Narrows a pass to these skills; the scheduler passes nothing. `skipGrace` is
 * for a caller that knows the wait is over for another reason.
 */
type AutoListScope = { onlySkillIds?: string[]; skipGrace?: boolean };

export async function listAutoListCandidateIds(scope: AutoListScope = {}) {
  const rows = await db
    .select({ id: skillDefinitions.id })
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        eq(skillDefinitions.visibility, "restricted"),
        eq(skillDefinitions.listingHold, false),
        publishedCurrentVersion("none", { settled: !scope.skipGrace }),
        scope.onlySkillIds
          ? inArray(skillDefinitions.id, scope.onlySkillIds)
          : undefined,
      ),
    )
    .orderBy(asc(skillDefinitions.createdAt), asc(skillDefinitions.id))
    .limit(AUTO_LIST_BATCH_SIZE);
  return rows.map((row) => row.id);
}

export type SkillListingQueueEntry = {
  skillId: string;
  skillVersionId: string;
  slug: string;
  displayName: string;
  description: string;
  submittedBy: string | null;
  capability: "prompt-only" | "executable" | null;
  license: string | null;
  sourceUrl: string | null;
  flags: string[];
  createdAt: string;
  reason: SkillListingQueueReason;
  visibility: "public" | "restricted";
  /** For a new version of a public skill: what it changed from the last one. */
  changes: SkillVersionChangelog | null;
};

/**
 * Two kinds of skill wait for an admin here:
 *
 * - Usable by whoever imported them but carrying an advisory flag, so going
 *   public is an admin's decision: list it, or withdraw it (which holds it and
 *   takes it out of this queue).
 * - Already public, whose current version brought scan flags or scripts the
 *   version before it did not have. Taking it down on its own would punish
 *   every author for every update; leaving it unseen would let a skill turn
 *   into something else after it was trusted. So it stays public and an admin
 *   looks: keep it (`acknowledgeSkillVersion`) or withdraw it.
 */
export async function listSkillListingQueue(): Promise<
  SkillListingQueueEntry[]
> {
  const [unlisted, updated] = await Promise.all([
    listFlaggedUnlistedSkills(),
    listEscalatedPublicSkills(),
  ]);
  return [...unlisted, ...updated];
}

async function listFlaggedUnlistedSkills(): Promise<SkillListingQueueEntry[]> {
  const rows = await db
    .select({ definition: skillDefinitions, version: skillVersions })
    .from(skillDefinitions)
    .innerJoin(
      skillVersions,
      and(
        eq(skillVersions.skillId, skillDefinitions.id),
        eq(skillVersions.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        eq(skillDefinitions.visibility, "restricted"),
        eq(skillDefinitions.listingHold, false),
        publishedCurrentVersion("some"),
      ),
    )
    .orderBy(asc(skillDefinitions.createdAt), asc(skillDefinitions.id))
    .limit(AUTO_LIST_BATCH_SIZE);
  return rows.map(({ definition, version }) => {
    const registry = version.manifestJson.registry;
    return {
      skillId: definition.id,
      skillVersionId: version.id,
      slug: definition.slug,
      displayName: definition.displayName,
      description: definition.description,
      submittedBy: definition.ownerUserId,
      capability: registry?.capability ?? null,
      license: registry?.license ?? null,
      sourceUrl: registry?.sourceUrl ?? null,
      flags: registry?.scan.flags ?? [],
      createdAt: definition.createdAt.toISOString(),
      reason: "flagged" as const,
      visibility: "restricted" as const,
      changes: null,
    };
  });
}

const previousVersion = alias(skillVersions, "previous_version");

type ManifestColumn = typeof skillVersions.manifestJson;
const flagsOf = (manifest: ManifestColumn | SQLWrapper) =>
  sql`coalesce(${manifest}->'registry'->'scan'->'flags', '[]'::jsonb)`;
const filesOf = (manifest: ManifestColumn | SQLWrapper) =>
  sql`coalesce(${manifest}->'registry'->'fileManifest', '[]'::jsonb)`;

/**
 * Public community skills whose current version carries a scan flag or ships a
 * script that the published version before it did not, and that no admin has
 * kept since. "Before it" is the latest published version created earlier —
 * the version the workspace update notice and the public changelog compare
 * with too.
 */
async function listEscalatedPublicSkills(): Promise<SkillListingQueueEntry[]> {
  const rows = await db
    .select({
      definition: skillDefinitions,
      version: skillVersions,
      previous: {
        storagePointer: previousVersion.storagePointer,
        manifestJson: previousVersion.manifestJson,
      },
    })
    .from(skillDefinitions)
    .innerJoin(
      skillVersions,
      and(
        eq(skillVersions.skillId, skillDefinitions.id),
        eq(skillVersions.isCurrent, true),
        eq(skillVersions.status, "published"),
      ),
    )
    .innerJoin(
      previousVersion,
      sql`${previousVersion.id} = (
        select earlier.id from ${skillVersions} earlier
        where earlier.skill_id = ${skillDefinitions.id}
          and earlier.status = 'published'
          and earlier.id <> ${skillVersions.id}
          and earlier.created_at < ${skillVersions.createdAt}
        order by earlier.created_at desc, earlier.id desc
        limit 1
      )`,
    )
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        eq(skillDefinitions.visibility, "public"),
        sql`${skillVersions.manifestJson}->'market'->>'acknowledgedAt' is null`,
        sql`(
          exists (
            select 1 from jsonb_array_elements_text(${flagsOf(skillVersions.manifestJson)}) as flag(name)
            where not (${flagsOf(previousVersion.manifestJson)} @> jsonb_build_array(flag.name))
          )
          or exists (
            select 1 from jsonb_array_elements(${filesOf(skillVersions.manifestJson)}) as file(entry)
            where file.entry->>'role' = 'script'
              and not exists (
                select 1 from jsonb_array_elements(${filesOf(previousVersion.manifestJson)}) as earlier(entry)
                where earlier.entry->>'role' = 'script'
                  and earlier.entry->>'path' = file.entry->>'path'
              )
          )
        )`,
      ),
    )
    .orderBy(asc(skillVersions.createdAt), asc(skillVersions.id))
    .limit(AUTO_LIST_BATCH_SIZE);
  return rows.map(({ definition, version, previous }) => {
    const registry = version.manifestJson.registry;
    const changes = diffSkillVersions(
      changelogVersion(previous),
      changelogVersion(version),
    );
    return {
      skillId: definition.id,
      skillVersionId: version.id,
      slug: definition.slug,
      displayName: definition.displayName,
      description: definition.description,
      submittedBy: definition.ownerUserId,
      capability: registry?.capability ?? null,
      license: registry?.license ?? null,
      sourceUrl: registry?.sourceUrl ?? null,
      flags: registry?.scan.flags ?? [],
      // When the version arrived, which is what the admin is deciding about.
      createdAt: version.createdAt.toISOString(),
      reason:
        changes.newFlags.length > 0 ? "new-version-flags" : "new-version-scripts",
      visibility: "public" as const,
      changes,
    };
  });
}

/**
 * The admin keeps a public skill whose new version entered the queue. Recorded
 * on that version's manifest (`market.acknowledgedAt`/`acknowledgedBy`), so the
 * decision is about this content: the next version that adds flags or scripts
 * asks again. null when the version is not the current published version of a
 * public community skill — nothing is waiting on it.
 */
export async function acknowledgeSkillVersion(input: {
  skillVersionId: string;
  actorUserId: string;
}): Promise<{
  skillId: string;
  skillVersionId: string;
  acknowledgedAt: string;
} | null> {
  const acknowledgedAt = new Date().toISOString();
  const [row] = await db
    .update(skillVersions)
    .set({
      manifestJson: sql`jsonb_set(${skillVersions.manifestJson}, '{market}', coalesce(${skillVersions.manifestJson}->'market', '{}'::jsonb) || jsonb_build_object('acknowledgedAt', ${acknowledgedAt}::text, 'acknowledgedBy', ${input.actorUserId}::text))`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(skillVersions.id, input.skillVersionId),
        eq(skillVersions.isCurrent, true),
        eq(skillVersions.status, "published"),
        sql`exists (
          select 1 from ${skillDefinitions}
          where ${skillDefinitions.id} = ${skillVersions.skillId}
            and ${skillDefinitions.sourceType} = 'registry_github'
            and ${skillDefinitions.status} = 'active'
            and ${skillDefinitions.visibility} = 'public'
        )`,
      ),
    )
    .returning({ skillId: skillVersions.skillId, id: skillVersions.id });
  return row
    ? { skillId: row.skillId, skillVersionId: row.id, acknowledgedAt }
    : null;
}

/**
 * Public skills with no `listed_at`: made public by a path other than
 * `listSkillPublicly` (the review queue's publish-and-make-public). They are
 * already visible; this gives them the date and categories browsing needs.
 */
async function listUndatedPublicSkillIds(scope: AutoListScope) {
  const rows = await db
    .select({ id: skillDefinitions.id })
    .from(skillDefinitions)
    .where(
      and(
        ne(skillDefinitions.sourceType, "builtin"),
        eq(skillDefinitions.visibility, "public"),
        isNull(skillDefinitions.listedAt),
        scope.onlySkillIds
          ? inArray(skillDefinitions.id, scope.onlySkillIds)
          : undefined,
      ),
    )
    .limit(AUTO_LIST_BATCH_SIZE);
  return rows.map((row) => row.id);
}

export async function runSkillAutoListing(scope: AutoListScope = {}): Promise<{
  listed: number;
  failed: number;
  backfilled: number;
}> {
  let listed = 0;
  let failed = 0;
  for (const skillId of await listAutoListCandidateIds(scope)) {
    try {
      const result = await listSkillPublicly({
        skillId,
        actorUserId: SKILL_AUTO_LIST_ACTOR,
      });
      if (result) listed += 1;
    } catch (error) {
      // One skill that cannot be listed must not stop the rest of the batch.
      failed += 1;
      logger.warn("Skill auto-listing failed", {
        skillId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const undated = await listUndatedPublicSkillIds(scope);
  for (const skillId of undated) {
    await prepareSkillListing(skillId);
  }
  return { listed, failed, backfilled: undated.length };
}
