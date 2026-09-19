import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  type SkillManifestJson,
  skillVersionFiles,
  skillVersions,
} from "@sourceweft/db";
import { assertRegistryStorageInvariant } from "../repository";
import { triageRegistrySubmission, type RegistryExistingEntry } from "./guard";
import { RegistrySubmissionError } from "./errors";

/**
 * Stage 5 — Index (persist the definition, version and bundle).
 * docs/architecture/skill-registry-index.md §3 Stage 5 / build phase R2.
 *
 * Writes a `sourceType='registry_github'` definition, a `storageType='db_text'`
 * version carrying the frozen metadata (frontmatter + capability/scan +
 * `fileManifest`), and the bundle files themselves — the same storage every
 * custom skill uses, so registry skills resolve through the ordinary
 * `loadSkillVersionBundle` path with no branch of their own.
 *
 * Storing the bundle is what makes an indexed skill survive the upstream repo
 * being deleted, rewritten or unreachable, and it is how every comparable
 * project (LobeHub, Dify, Open WebUI) works. The line we do not cross is
 * exposing that content as a retrievable artifact: there is no endpoint that
 * hands a skill's files back out by id or hash. Provenance rides in
 * `storagePointer` (`github:<owner>/<repo>@<40hex>#<subpath>`) and attribution
 * in `manifestJson.registry`.
 */

// The `version` label is derived from the pinned commit so each distinct commit
// is its own version. A repeated source returns the immutable existing version.
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
  /** The bundle bodies to persist, bundle-relative. */
  files: RegistrySkillFile[];
};

export type RegistrySkillFile = {
  path: string;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
};

export type UpsertRegistrySkillResult = {
  slug: string;
  skillId: string;
  skillVersionId: string;
  version: string;
  status: "indexed" | "queued";
  flags: string[];
  diagnostics: NonNullable<
    NonNullable<SkillManifestJson["registry"]>["ingestion"]
  >["diagnostics"];
};

/**
 * Build the definition + version insert values for a registry skill. Pure; the
 * bundle bodies are written separately by `upsertRegistrySkillIndex`.
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
  const storageType = "db_text" as const;
  // `repo_builtin` is reserved for skills whose bodies ship in this repo.
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
): Promise<(RegistryExistingEntry & { skillId: string }) | null> {
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

/**
 * The definition + best version for an indexed registry slug, or null.
 * Used by agent-driven install to resolve a slug the model named, and to tell
 * a published skill from one still held in the review queue.
 *
 * "Best" is the current version when there is one, else the newest. A version
 * held for review is never `isCurrent` (only a published one is), so matching
 * on `isCurrent` alone made every queued skill invisible to this lookup — the
 * caller then reported "no installable skill found" for a skill that had just
 * been indexed and was merely awaiting review.
 */
export async function getRegistrySkillBySlug(slug: string) {
  const [row] = await db
    .select({ definition: skillDefinitions, version: skillVersions })
    .from(skillDefinitions)
    .innerJoin(skillVersions, eq(skillVersions.skillId, skillDefinitions.id))
    .where(
      and(
        eq(skillDefinitions.slug, slug),
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
      ),
    )
    .orderBy(desc(skillVersions.isCurrent), desc(skillVersions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function upsertRegistrySkillIndex(
  input: UpsertRegistrySkillInput,
): Promise<UpsertRegistrySkillResult> {
  const version = input.commitSha.slice(0, VERSION_SHA_PREFIX_LENGTH);
  const now = new Date();
  return db.transaction(async (tx) => {
    // Also serializes first insertion, where no definition row exists to lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"registry:" + input.slug}))`,
    );
    const [existing] = await tx
      .select()
      .from(skillDefinitions)
      .where(eq(skillDefinitions.slug, input.slug))
      .limit(1);
    if (
      existing &&
      (existing.sourceType !== "registry_github" ||
        (existing.ownerUserId && existing.ownerUserId !== input.submitterId))
    ) {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_CONFLICT",
        "This skill belongs to another submitter or source",
      );
    }
    const skillId = existing?.id ?? randomUUID();
    const [existingVersion] = await tx
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.version, version),
        ),
      )
      .limit(1);
    if (existingVersion) {
      if (existingVersion.storagePointer !== input.storagePointer) {
        throw new RegistrySubmissionError(
          "REGISTRY_VERSION_CONFLICT",
          "Version label refers to a different full source commit or path",
        );
      }
      const stored = await tx
        .select()
        .from(skillVersionFiles)
        .where(eq(skillVersionFiles.skillVersionId, existingVersion.id));
      const hashes = (files: Array<{ path: string; contentHash: string }>) =>
        JSON.stringify(
          files
            .map((f) => [f.path, f.contentHash])
            .sort((a, b) => a[0]!.localeCompare(b[0]!)),
        );
      if (hashes(stored) !== hashes(input.files)) {
        throw new RegistrySubmissionError(
          "REGISTRY_VERSION_CONFLICT",
          "This source has different files from the stored immutable version",
        );
      }
      if (
        existing?.status !== "active" ||
        (existingVersion.status !== "published" &&
          existingVersion.status !== "draft")
      ) {
        throw new RegistrySubmissionError(
          "REGISTRY_VERSION_UNAVAILABLE",
          "This version was revoked or disabled; resubmitting cannot restore it",
        );
      }
      return {
        slug: input.slug,
        skillId,
        skillVersionId: existingVersion.id,
        version,
        status: existingVersion.status === "published" ? "indexed" : "queued",
        flags: existingVersion.manifestJson.registry?.scan.flags ?? [],
        diagnostics:
          existingVersion.manifestJson.registry?.ingestion?.diagnostics ?? [],
      };
    }
    if (existing?.status === "archived")
      throw new RegistrySubmissionError(
        "REGISTRY_VERSION_UNAVAILABLE",
        "This skill is archived",
      );
    const [latest] = await tx
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.createdAt), desc(skillVersions.id))
      .limit(1);
    const decision = triageRegistrySubmission({
      existing: existing
        ? {
            ownerUserId: existing.ownerUserId,
            definitionStatus: existing.status,
            currentVersionStatus: latest?.status ?? null,
          }
        : null,
      submitterId: input.submitterId,
      scan: input.manifestJson.registry!.scan,
    });
    const values = buildRegistryUpsertValues({
      ...input,
      version,
      versionStatus: decision.versionStatus,
    });
    if (!existing) {
      await tx
        .insert(skillDefinitions)
        .values({
          id: skillId,
          ...values.definition,
          slug: input.slug,
          ownerUserId: input.submitterId,
          createdAt: now,
          updatedAt: now,
        });
    } else if (values.version.isCurrent) {
      await tx
        .update(skillDefinitions)
        .set({
          displayName: input.displayName,
          description: input.description,
          updatedAt: now,
        })
        .where(eq(skillDefinitions.id, skillId));
    }
    if (values.version.isCurrent) {
      await tx
        .update(skillVersions)
        .set({ isCurrent: false, updatedAt: now })
        .where(eq(skillVersions.skillId, skillId));
    }
    const skillVersionId = randomUUID();
    await tx
      .insert(skillVersions)
      .values({
        id: skillVersionId,
        skillId,
        ...values.version,
        createdBy: input.submitterId,
        publishedAt: values.version.isCurrent ? now : null,
        createdAt: now,
        updatedAt: now,
      });
    if (input.files.length)
      await tx
        .insert(skillVersionFiles)
        .values(
          input.files.map((file) => ({
            ...file,
            id: randomUUID(),
            skillVersionId,
            createdAt: now,
          })),
        );
    return {
      slug: input.slug,
      skillId,
      skillVersionId,
      version,
      status: decision.outcome,
      flags: input.manifestJson.registry?.scan.flags ?? [],
      diagnostics: input.manifestJson.registry?.ingestion?.diagnostics ?? [],
    };
  });
}
