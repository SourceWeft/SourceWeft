import { and, desc, eq } from "drizzle-orm";
import { db, skillDefinitions, skillVersions } from "@sourceweft/db";

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
};

export async function listRegistryReviewQueue(): Promise<
  RegistryReviewQueueEntry[]
> {
  const rows = await db
    .select({ definition: skillDefinitions, version: skillVersions })
    .from(skillVersions)
    .innerJoin(
      skillDefinitions,
      eq(skillDefinitions.id, skillVersions.skillId),
    )
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
      displayName: row.definition.displayName,
      description: row.definition.description,
      submittedBy: registry?.submittedBy ?? row.definition.ownerUserId ?? null,
      capability: registry?.capability ?? null,
      license: registry?.license ?? null,
      sourceUrl: registry?.sourceUrl ?? null,
      flags: registry?.scan?.flags ?? [],
      createdAt: row.version.createdAt.toISOString(),
    };
  });
}

/**
 * Approve (publish) or deprecate a queued registry version. Publish only acts on
 * a `draft` (so it can't republish a deprecated version); deprecate acts on a
 * `draft` or `published` version (rejecting a queued submission or taking down a
 * live one). Publishing promotes the version to current and demotes any prior
 * current version.
 */
export async function setRegistrySkillVersionStatus(
  skillVersionId: string,
  target: "published" | "deprecated",
): Promise<{ skillVersionId: string; status: "published" | "deprecated" } | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select({
        id: skillVersions.id,
        skillId: skillVersions.skillId,
        status: skillVersions.status,
      })
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
    if (!version) {
      return null;
    }

    if (target === "published") {
      if (version.status !== "draft") {
        return null;
      }
      await tx
        .update(skillVersions)
        .set({ isCurrent: false, updatedAt: now })
        .where(eq(skillVersions.skillId, version.skillId));
      await tx
        .update(skillVersions)
        .set({
          status: "published",
          isCurrent: true,
          publishedAt: now,
          updatedAt: now,
        })
        .where(eq(skillVersions.id, skillVersionId));
      return { skillVersionId, status: "published" };
    }

    if (version.status !== "draft" && version.status !== "published") {
      return null;
    }
    await tx
      .update(skillVersions)
      .set({ status: "deprecated", isCurrent: false, updatedAt: now })
      .where(eq(skillVersions.id, skillVersionId));
    return { skillVersionId, status: "deprecated" };
  });
}
