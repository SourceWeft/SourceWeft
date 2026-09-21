import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, skillDefinitions, skillVersions } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
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
};

/**
 * Skills that are usable by whoever imported them but carry an advisory flag,
 * so going public is an admin's decision: list it, or withdraw it (which holds
 * it and takes it out of this queue).
 */
export async function listSkillListingQueue(): Promise<
  SkillListingQueueEntry[]
> {
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
    };
  });
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
