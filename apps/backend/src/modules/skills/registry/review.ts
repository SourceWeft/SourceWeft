import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db, skillDefinitions, skillVersions } from "@sourceweft/db";
import { ContentError } from "../../content/errors";
import { registryVersionTakesCurrent } from "./repository";

/**
 * Admin moderation queue for registry submissions — mirrors `market/review.ts`
 * semantics onto the version `status` (docs/architecture/skill-registry-index.md
 * §3 Stage 5). A queued submission is a `draft` version; an admin publishes
 * (`draft`→`published`) or deprecates (`→deprecated`). There is no hard delete:
 * `deprecated` is a tombstone the runtime revocation gate already honors.
 */

export type RegistryReviewQueueEntry = {
  slug: string;
  skillId: string;
  skillVersionId: string;
  displayName: string;
  description: string;
  submittedBy: string | null;
  capability: "prompt-only" | "executable" | null;
  license: string | null;
  sourceUrl: string | null;
  flags: string[];
  createdAt: string;
  ingestion:
    | NonNullable<
        import("@sourceweft/db").SkillManifestJson["registry"]
      >["ingestion"]
    | null;
};

export async function listRegistryReviewQueue(): Promise<
  RegistryReviewQueueEntry[]
> {
  const rows = await db
    .select({ definition: skillDefinitions, version: skillVersions })
    .from(skillVersions)
    .innerJoin(skillDefinitions, eq(skillDefinitions.id, skillVersions.skillId))
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillVersions.status, "draft"),
      ),
    )
    .orderBy(desc(skillVersions.createdAt));

  return rows.map((row) => {
    const registry = row.version.manifestJson.registry;
    return {
      slug: row.definition.slug,
      skillId: row.definition.id,
      skillVersionId: row.version.id,
      displayName: row.version.manifestJson.displayName,
      description: row.version.manifestJson.description,
      submittedBy: registry?.submittedBy ?? row.definition.ownerUserId ?? null,
      capability: registry?.capability ?? null,
      license: registry?.license ?? null,
      sourceUrl: registry?.sourceUrl ?? null,
      flags: registry?.scan?.flags ?? [],
      createdAt: row.version.createdAt.toISOString(),
      ingestion: registry?.ingestion ?? null,
    };
  });
}

/**
 * Approve (publish) or deprecate a queued registry version. Publish only acts on
 * a `draft` (so it can't republish a deprecated version); deprecate acts on a
 * `draft` or `published` version (rejecting a queued submission or taking down a
 * live one). Publishing promotes the version to current and demotes the prior
 * current version — unless that one is pinned to a NEWER commit, in which case
 * the approved version is published as history and the catalog is not rolled
 * back (`registryVersionTakesCurrent`).
 *
 * Revoking the CURRENT version hands currency to the best published version
 * left (`pickRevocationSuccessor`), so one bad release does not take the whole
 * skill out of the catalog while good older ones exist. Workspaces pinned to the
 * revoked version are not moved: the pin is theirs, and the runtime revocation
 * gate already covers it.
 */
function committedAtMs(committedAt: string | undefined): number | null {
  const ms = committedAt ? Date.parse(committedAt) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Which published version becomes current when the current one is revoked.
 * Same ordering `registryVersionTakesCurrent` enforces on the way in, applied on
 * the way out: the newest commit wins, a version with no recorded commit date
 * ranks below every dated one, and ties (equal dates, or no date on either
 * side) fall to the newer write.
 */
export function pickRevocationSuccessor<
  T extends { committedAt: string | undefined; createdAt: Date },
>(candidates: T[]): T | null {
  const ranked = [...candidates].sort((a, b) => {
    const left = committedAtMs(a.committedAt);
    const right = committedAtMs(b.committedAt);
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  return ranked[0] ?? null;
}

export async function setRegistrySkillVersionStatus(
  skillVersionId: string,
  target: "published" | "deprecated",
  decision: {
    actorUserId: string;
    reason?: string;
    visibility?: "public" | "restricted";
  },
): Promise<{
  skillVersionId: string;
  status: "published" | "deprecated";
} | null> {
  if (target === "deprecated" && !decision.reason?.trim())
    throw new ContentError(
      400,
      "REVIEW_REASON_REQUIRED",
      "Rejecting or revoking a version requires a reason",
    );
  const now = new Date();
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select({ slug: skillDefinitions.slug, skillId: skillDefinitions.id })
      .from(skillVersions)
      .innerJoin(
        skillDefinitions,
        eq(skillDefinitions.id, skillVersions.skillId),
      )
      .where(
        and(
          eq(skillVersions.id, skillVersionId),
          eq(skillDefinitions.sourceType, "registry_github"),
        ),
      )
      .limit(1);
    if (!identity) return null;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"registry:" + identity.slug}))`,
    );
    const [definition] = await tx
      .select()
      .from(skillDefinitions)
      .where(eq(skillDefinitions.id, identity.skillId))
      .limit(1)
      .for("update");
    const [version] = await tx
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, skillVersionId))
      .limit(1)
      .for("update");
    if (!definition || !version || definition.status !== "active") return null;
    if (
      target === "published"
        ? version.status !== "draft"
        : version.status !== "draft" && version.status !== "published"
    )
      return null;
    const registry = version.manifestJson.registry;
    if (!registry)
      throw new ContentError(
        409,
        "REGISTRY_METADATA_MISSING",
        "This version has no registry metadata",
      );
    // Taking down the live current version: line up its successor first so the
    // audit record below can name it. Drafts are never candidates — only what
    // an admin (or a clean auto-index) already published.
    const successor =
      target === "deprecated" &&
      version.status === "published" &&
      version.isCurrent
        ? (pickRevocationSuccessor(
            (
              await tx
                .select()
                .from(skillVersions)
                .where(
                  and(
                    eq(skillVersions.skillId, identity.skillId),
                    eq(skillVersions.status, "published"),
                    ne(skillVersions.id, skillVersionId),
                  ),
                )
                .for("update")
            ).map((row) => ({
              row,
              committedAt: row.manifestJson.registry?.committedAt,
              createdAt: row.createdAt,
            })),
          )?.row ?? null)
        : null;
    const manifestJson = {
      ...version.manifestJson,
      registry: {
        ...registry,
        ...(decision.visibility
          ? {
              visibilityChange: {
                actorUserId: decision.actorUserId,
                at: now.toISOString(),
                visibility: decision.visibility,
              },
            }
          : {}),
        moderation: {
          action:
            target === "published"
              ? ("publish" as const)
              : version.status === "draft"
                ? ("reject" as const)
                : ("revoke" as const),
          actorUserId: decision.actorUserId,
          at: now.toISOString(),
          ...(decision.reason?.trim()
            ? { reason: decision.reason.trim() }
            : {}),
          ...(successor ? { promotedSkillVersionId: successor.id } : {}),
        },
      },
    };
    // What other people see and install is the CURRENT version, so opening a
    // skill to everyone has to be decided while looking at that one. Approving
    // an older draft with "make public" would publish a version the admin did
    // not have in front of them. Restricting is always allowed: it only closes.
    const refusePublic = () =>
      new ContentError(
        409,
        "SKILL_VISIBILITY_NOT_CURRENT",
        "This is not the version people would get. Make the skill public from its current version.",
      );
    if (decision.visibility === "public" && target !== "published") {
      throw refusePublic();
    }
    let takesCurrent = false;
    if (target === "published") {
      // Review order is not commit order: a draft can sit in the queue while a
      // newer commit of the same skill is indexed and goes live.
      const [current] = await tx
        .select({ manifestJson: skillVersions.manifestJson })
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, identity.skillId),
            eq(skillVersions.isCurrent, true),
          ),
        )
        .limit(1);
      takesCurrent = registryVersionTakesCurrent({
        candidateCommittedAt: registry.committedAt,
        current: current
          ? { committedAt: current.manifestJson.registry?.committedAt }
          : null,
      });
      if (decision.visibility === "public" && !takesCurrent) {
        throw refusePublic();
      }
      if (takesCurrent) {
        await tx
          .update(skillVersions)
          .set({ isCurrent: false, updatedAt: now })
          .where(eq(skillVersions.skillId, identity.skillId));
      }
      // Display fields follow the current version only. Visibility is about
      // the skill as a whole; "public" was refused above unless this version
      // is the one that goes live.
      if (takesCurrent || decision.visibility) {
        await tx
          .update(skillDefinitions)
          .set({
            ...(takesCurrent
              ? {
                  displayName: version.manifestJson.displayName,
                  description: version.manifestJson.description,
                  // New content is not vouched for until an admin looks again.
                  verified: false,
                }
              : {}),
            ...(decision.visibility ? { visibility: decision.visibility } : {}),
            updatedAt: now,
          })
          .where(eq(skillDefinitions.id, identity.skillId));
      }
    }
    await tx
      .update(skillVersions)
      .set({
        status: target,
        isCurrent: takesCurrent,
        publishedAt: target === "published" ? now : version.publishedAt,
        manifestJson,
        updatedAt: now,
      })
      .where(eq(skillVersions.id, skillVersionId));
    if (successor) {
      // After the write above: at most one version of a skill may be current.
      await tx
        .update(skillVersions)
        .set({ isCurrent: true, updatedAt: now })
        .where(eq(skillVersions.id, successor.id));
      // Display fields follow the current version, as they do on publish.
      await tx
        .update(skillDefinitions)
        .set({
          displayName: successor.manifestJson.displayName,
          description: successor.manifestJson.description,
          // A different version is what users get now; vouch for it again.
          verified: false,
          updatedAt: now,
        })
        .where(eq(skillDefinitions.id, identity.skillId));
    }
    return { skillVersionId, status: target };
  });
}

export async function setRegistryVisibility(input: {
  skillId: string;
  visibility: "public" | "restricted";
  actorUserId: string;
}) {
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .select()
      .from(skillDefinitions)
      .where(
        and(
          eq(skillDefinitions.id, input.skillId),
          eq(skillDefinitions.sourceType, "registry_github"),
          eq(skillDefinitions.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    if (!definition) return null;
    const [current] = await tx
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, input.skillId),
          eq(skillVersions.isCurrent, true),
          eq(skillVersions.status, "published"),
        ),
      )
      .limit(1)
      .for("update");
    if (!current?.manifestJson.registry)
      throw new ContentError(
        409,
        "REGISTRY_NOT_PUBLISHED",
        "An active published current version is required",
      );
    const now = new Date();
    await tx
      .update(skillDefinitions)
      .set({ visibility: input.visibility, updatedAt: now })
      .where(eq(skillDefinitions.id, input.skillId));
    await tx
      .update(skillVersions)
      .set({
        manifestJson: {
          ...current.manifestJson,
          registry: {
            ...current.manifestJson.registry,
            visibilityChange: {
              actorUserId: input.actorUserId,
              at: now.toISOString(),
              visibility: input.visibility,
            },
          },
        },
        updatedAt: now,
      })
      .where(eq(skillVersions.id, current.id));
    return { skillId: input.skillId, visibility: input.visibility };
  });
}
