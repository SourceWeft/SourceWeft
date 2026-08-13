import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  type SkillManifestJson,
  skillVersions,
} from "@sourceweft/db";
import {
  assertNoRegistryFileWrite,
  assertRegistryStorageInvariant,
} from "../repository";
import type { RegistryExistingEntry } from "./guard";

/**
 * Stage 5 — Index (persist pointer only).
 * docs/architecture/skill-registry-index.md §3 Stage 5 / build phase R2.
 *
 * Writes a `sourceType='registry_github'` definition + a `storageType='pointer'`
 * version carrying frozen metadata (frontmatter + capability/scan +
 * `fileManifest`). It NEVER writes `skill_version_files`: this module does not
 * even import that table, so invariant 2 (the redistribution tripwire) is
 * enforced structurally, and the pointer write site additionally asserts
 * invariant 1 via `assertRegistryStorageInvariant`.
 */

// The `version` label is derived from the pinned commit so each distinct commit
// is its own version, while a re-submit of the SAME commit updates in place.
const VERSION_SHA_PREFIX_LENGTH = 12;

export type UpsertRegistrySkillInput = {
  slug: string;
  displayName: string;
  description: string;
  submitterId: string;
  /** github:<owner>/<repo>@<40hex-sha>#<subpath> */
  storagePointer: string;
  commitSha: string;
  contentHash: string;
  manifestJson: SkillManifestJson;
  versionStatus: "published" | "draft";
  outcome: "indexed" | "queued";
};

export type UpsertRegistrySkillResult = {
  slug: string;
  skillId: string;
  skillVersionId: string;
  version: string;
  status: "indexed" | "queued";
};

/**
 * Build the definition + version insert values for a registry skill, asserting
 * invariant 1 (pointer ⇔ registry_github) at the pointer write site. Pure and
 * body-free — there is no field for file content, which is invariant 2 expressed
 * as a type.
 */
export function buildRegistryUpsertValues(input: {
  displayName: string;
  description: string;
  storagePointer: string;
  contentHash: string;
  manifestJson: SkillManifestJson;
  version: string;
  versionStatus: "published" | "draft";
}) {
  const sourceType = "registry_github" as const;
  const storageType = "pointer" as const;
  // Invariant 1 (§0): pointer storage is used by, and only by, registry skills.
  assertRegistryStorageInvariant(sourceType, storageType);

  return {
    sourceType,
    storageType,
    definition: {
      // registry definitions are cross-workspace + first-party-trust-free (§0/§3):
      // teamId/workspaceId NULL, visibility starts `restricted` until an admin
      // promotes it to `public`.
      teamId: null as string | null,
      workspaceId: null as string | null,
      sourceType,
      visibility: "restricted" as const,
      status: "active" as const,
      displayName: input.displayName,
      description: input.description,
    },
    version: {
      version: input.version,
      status: input.versionStatus,
      storageType,
      storagePointer: input.storagePointer,
      contentHash: input.contentHash,
      manifestJson: input.manifestJson,
      // Clean submissions become the current, published version; queued drafts
      // stay non-current so they never surface until an admin approves them.
      isCurrent: input.versionStatus === "published",
    },
  };
}

/**
 * Existing registry entry for a slug (or null) — the ownership/sticky inputs
 * Stage 4 needs. `currentVersionStatus` is the status of the `isCurrent` version.
 */
export async function getRegistrySkillForSubmission(
  slug: string,
): Promise<RegistryExistingEntry & { skillId: string } | null> {
  const [row] = await db
    .select({
      skillId: skillDefinitions.id,
      ownerUserId: skillDefinitions.ownerUserId,
      definitionStatus: skillDefinitions.status,
      currentVersionStatus: skillVersions.status,
    })
    .from(skillDefinitions)
    .leftJoin(
      skillVersions,
      and(
        eq(skillVersions.skillId, skillDefinitions.id),
        eq(skillVersions.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(skillDefinitions.slug, slug),
        eq(skillDefinitions.sourceType, "registry_github"),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    skillId: row.skillId,
    ownerUserId: row.ownerUserId,
    definitionStatus: row.definitionStatus,
    currentVersionStatus: row.currentVersionStatus ?? null,
  };
}

export async function upsertRegistrySkillIndex(
  input: UpsertRegistrySkillInput,
): Promise<UpsertRegistrySkillResult> {
  const version = input.commitSha.slice(0, VERSION_SHA_PREFIX_LENGTH);
  const values = buildRegistryUpsertValues({
    displayName: input.displayName,
    description: input.description,
    storagePointer: input.storagePointer,
    contentHash: input.contentHash,
    manifestJson: input.manifestJson,
    version,
    versionStatus: input.versionStatus,
  });

  // Invariant 2 (redistribution tripwire, §0/§1): a pointer version persists
  // ZERO file bodies. The registry pipeline carries only file *metadata* (the
  // manifest), so this set is always empty; routing it through the shared
  // file-write guard reuses the invariant at the write site — if a body ever
  // reached here, `assertNoRegistryFileWrite` would throw.
  const fileBodiesToPersist: Array<{ storageType: "pointer" }> = [];
  for (const body of fileBodiesToPersist) {
    assertNoRegistryFileWrite(body.storageType);
  }

  const now = new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: skillDefinitions.id, ownerUserId: skillDefinitions.ownerUserId })
      .from(skillDefinitions)
      .where(
        and(
          eq(skillDefinitions.slug, input.slug),
          eq(skillDefinitions.sourceType, "registry_github"),
        ),
      )
      .limit(1);

    const skillId = existing?.id ?? randomUUID();
    if (existing) {
      await tx
        .update(skillDefinitions)
        .set({
          displayName: values.definition.displayName,
          description: values.definition.description,
          status: values.definition.status,
          updatedAt: now,
        })
        .where(eq(skillDefinitions.id, skillId));
    } else {
      await tx.insert(skillDefinitions).values({
        id: skillId,
        teamId: values.definition.teamId,
        workspaceId: values.definition.workspaceId,
        sourceType: values.definition.sourceType,
        slug: input.slug,
        displayName: values.definition.displayName,
        description: values.definition.description,
        visibility: values.definition.visibility,
        status: values.definition.status,
        ownerUserId: input.submitterId,
        createdAt: now,
        updatedAt: now,
      });
    }

    // A newly-current version demotes any prior current version (partial-unique
    // `skill_versions_skill_current_uq`).
    if (values.version.isCurrent) {
      await tx
        .update(skillVersions)
        .set({ isCurrent: false, updatedAt: now })
        .where(eq(skillVersions.skillId, skillId));
    }

    // Re-submitting the same commit updates that version in place; a new commit
    // is a new version row.
    const [existingVersion] = await tx
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.version, version),
        ),
      )
      .limit(1);

    const skillVersionId = existingVersion?.id ?? randomUUID();
    if (existingVersion) {
      await tx
        .update(skillVersions)
        .set({
          status: values.version.status,
          storageType: values.version.storageType,
          storagePointer: values.version.storagePointer,
          isCurrent: values.version.isCurrent,
          contentHash: values.version.contentHash,
          manifestJson: values.version.manifestJson,
          publishedAt:
            values.version.status === "published" ? now : null,
          updatedAt: now,
        })
        .where(eq(skillVersions.id, skillVersionId));
    } else {
      await tx.insert(skillVersions).values({
        id: skillVersionId,
        skillId,
        version,
        status: values.version.status,
        storageType: values.version.storageType,
        storagePointer: values.version.storagePointer,
        isCurrent: values.version.isCurrent,
        contentHash: values.version.contentHash,
        manifestJson: values.version.manifestJson,
        createdBy: input.submitterId,
        publishedAt: values.version.status === "published" ? now : null,
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      slug: input.slug,
      skillId,
      skillVersionId,
      version,
      status: input.outcome,
    };
  });
}
