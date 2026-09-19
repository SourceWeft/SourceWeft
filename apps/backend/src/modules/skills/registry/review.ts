import { and, desc, eq, sql } from "drizzle-orm";
import { db, skillDefinitions, skillVersions } from "@sourceweft/db";
import { ContentError } from "../../content/errors";

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
 * live one). Publishing promotes the version to current and demotes any prior
 * current version.
 */
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
        },
      },
    };
    if (target === "published") {
      await tx
        .update(skillVersions)
        .set({ isCurrent: false, updatedAt: now })
        .where(eq(skillVersions.skillId, identity.skillId));
      await tx
        .update(skillDefinitions)
        .set({
          displayName: version.manifestJson.displayName,
          description: version.manifestJson.description,
          ...(decision.visibility ? { visibility: decision.visibility } : {}),
          updatedAt: now,
        })
        .where(eq(skillDefinitions.id, identity.skillId));
    }
    await tx
      .update(skillVersions)
      .set({
        status: target,
        isCurrent: target === "published",
        publishedAt: target === "published" ? now : version.publishedAt,
        manifestJson,
        updatedAt: now,
      })
      .where(eq(skillVersions.id, skillVersionId));
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
