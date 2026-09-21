import { randomUUID } from "node:crypto";
import { parseGithubStoragePointer } from "../storage/source-pointer";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  type SkillManifestJson,
  skillVersionFiles,
  skillVersions,
  skillRepoClaims,
} from "@sourceweft/db";
import {
  putSkillBlob,
  putSkillBundle,
  type StoredSkillBundle,
} from "../storage";
import { triageRegistrySubmission, type RegistryExistingEntry } from "./guard";
import { RegistrySubmissionError } from "./errors";

/**
 * Stage 5 — Index (persist the definition, version and bundle).
 * docs/architecture/skill-registry-index.md §3 Stage 5 / build phase R2.
 *
 * A registry skill is written in two steps, in this order:
 *   1. OBJECT STORAGE — every file as a content-addressed blob, and the whole
 *      skill as one deterministic zip bundle (`../storage`);
 *   2. THE DATABASE — a `sourceType='registry_github'` definition, a
 *      `storageType='object'` version carrying SKILL.md's text, the bundle's
 *      key/digest/size and the frozen metadata, and one manifest row per file
 *      (path, type, size, sha256, blob key — no content).
 * A row therefore never points at an object that was not stored. The reverse —
 * objects whose transaction then failed — is harmless: they are addressed by
 * their content, so the retry finds them already there, and nothing references
 * them until it commits.
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

/** Blob writes in flight at once: each is an existence check plus an upload. */
const BLOB_WRITE_CONCURRENCY = 8;

export type UpsertRegistrySkillInput = {
  slug: string;
  displayName: string;
  description: string;
  submitterId: string;
  /** github:<owner>/<repo>@<40hex-sha>#<subpath> */
  storagePointer: string;
  commitSha: string;
  manifestJson: SkillManifestJson;
  versionStatus: "published" | "draft";
  outcome: "indexed" | "queued";
  /** The whole bundle, SKILL.md included, as raw bytes; paths bundle-relative. */
  files: RegistrySkillFile[];
  /**
   * How this commit relates to the skill's current version, when the caller
   * asked GitHub (`compareCommits`): newer = it descends from the current
   * commit. Decides currency ahead of commit dates, which whoever writes the
   * commit sets. Applied only if the current version is still the one compared.
   */
  currency?: { againstVersionId: string; candidateIsNewer: boolean };
  /**
   * From the platform's own import only: mark the skill featured (or not).
   * Written when the skill is created, and afterwards unless a market admin
   * set it — an admin's choice is never overwritten by an import.
   */
  featured?: boolean;
};

export type RegistrySkillFile = {
  path: string;
  bytes: Uint8Array;
  mimeType: string;
};

/** What `storeRegistrySkillObjects` left in object storage. */
export type StoredRegistrySkill = {
  /** SKILL.md's text — the one file body the database keeps. */
  skillMd: string;
  bundle: StoredSkillBundle;
  files: Array<{
    path: string;
    mimeType: string;
    sizeBytes: number;
    /** sha256 of the file's bytes. */
    contentHash: string;
    objectKey: string;
  }>;
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

type SkillSourceType = (typeof skillDefinitions.$inferSelect)["sourceType"];
type SkillStorageType = (typeof skillVersions.$inferSelect)["storageType"];

/**
 * Where a skill's content lives follows from where the skill came from, one to
 * one: a builtin's body ships in this repo, a community skill's bytes are in
 * object storage, and a workspace-authored skill is inline text.
 */
const STORAGE_TYPE_BY_SOURCE = {
  builtin: "repo_builtin",
  registry_github: "object",
} as const satisfies Partial<Record<SkillSourceType, SkillStorageType>>;

/**
 * Guard at every version write site: `builtin ⇔ repo_builtin`,
 * `registry_github ⇔ object`, and everything else (custom skills) ⇔ `db_text`.
 * A mismatch means a reader would look for the content in the wrong place.
 */
export function assertSkillStorageInvariant(
  sourceType: SkillSourceType,
  storageType: SkillStorageType,
): void {
  const expected: SkillStorageType =
    (
      STORAGE_TYPE_BY_SOURCE as Partial<
        Record<SkillSourceType, SkillStorageType>
      >
    )[sourceType] ?? "db_text";
  if (storageType !== expected) {
    throw new Error(
      `Skill storage invariant violated: storageType='${storageType}' with sourceType='${sourceType}' (expected '${expected}')`,
    );
  }
}

/**
 * Build the definition + version insert values for a registry skill. Pure; the
 * per-file manifest rows are written separately by `upsertRegistrySkillIndex`.
 */
export function buildRegistryUpsertValues(input: {
  displayName: string;
  description: string;
  storagePointer: string;
  skillMd: string;
  bundle: StoredSkillBundle;
  manifestJson: SkillManifestJson;
  version: string;
  versionStatus: "published" | "draft";
}) {
  const sourceType = "registry_github" as const;
  const storageType = "object" as const;
  assertSkillStorageInvariant(sourceType, storageType);

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
      // The bundle digest IS the version's content identity: it covers every
      // file's path and bytes, and it is the same value the storage key and
      // the sandbox's staging stamp are derived from.
      contentHash: input.bundle.sha256,
      skillMd: input.skillMd,
      bundleSha256: input.bundle.sha256,
      bundleObjectKey: input.bundle.objectKey,
      bundleSizeBytes: input.bundle.sizeBytes,
      manifestJson: input.manifestJson,
      // Only a published version is ELIGIBLE to be current; queued drafts stay
      // non-current so they never surface until an admin approves them. Whether
      // an eligible version actually takes over is decided against the stored
      // current version — see `registryVersionTakesCurrent`.
      isCurrent: input.versionStatus === "published",
    },
  };
}

/**
 * Step 1 of the write: put every file and the bundle into object storage.
 *
 * Every key is derived from the content, and a put is put-if-absent, so running
 * this again — a retried job, the same commit re-submitted — uploads nothing
 * and returns the same keys. Any failure rejects before the caller has opened
 * its transaction.
 */
export async function storeRegistrySkillObjects(
  files: readonly RegistrySkillFile[],
): Promise<StoredRegistrySkill> {
  const skillMdFile = files.find((file) => file.path === "SKILL.md");
  if (!skillMdFile) {
    throw new Error("A registry skill bundle must contain SKILL.md");
  }
  const stored: StoredRegistrySkill["files"] = new Array(files.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    // `failed` stops the other workers from starting uploads for a write that
    // is already lost.
    while (next < files.length && !failed) {
      const index = next++;
      const file = files[index]!;
      const blob = await putSkillBlob({
        bytes: file.bytes,
        mimeType: file.mimeType,
      }).catch((error: unknown) => {
        failed = true;
        throw error;
      });
      stored[index] = {
        path: file.path,
        mimeType: file.mimeType,
        sizeBytes: blob.sizeBytes,
        contentHash: blob.sha256,
        objectKey: blob.objectKey,
      };
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(BLOB_WRITE_CONCURRENCY, files.length) },
      worker,
    ),
  );
  const bundle = await putSkillBundle(
    files.map((file) => ({ path: file.path, bytes: file.bytes })),
  );
  return {
    skillMd: Buffer.from(skillMdFile.bytes).toString("utf8"),
    bundle,
    files: stored,
  };
}

function committedAtMs(committedAt: string | undefined): number | null {
  const ms = committedAt ? Date.parse(committedAt) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether a newly PUBLISHED version replaces the current one. Shared by the
 * index write and admin publish so both agree.
 *
 * Currency follows the commit's age, not the order writes happen to land in:
 * two submissions of one skill can finish in either order, and an admin can
 * approve an old queued draft after a newer version is already live — neither
 * may roll the catalog back. So a version takes over only if its commit is not
 * older than the current version's; equal dates fall to the newer write.
 *
 * Every registry version is dated — ingest refuses a commit whose date it
 * cannot read — so the `undefined` in the types is the manifest's optional
 * field, not a case that occurs. Should one turn up anyway it ranks as oldest:
 * an undated candidate never takes over, an undated current always yields.
 */
export function registryVersionTakesCurrent(input: {
  candidateCommittedAt: string | undefined;
  /** The stored `isCurrent` version, or null when the skill has none. */
  current: { committedAt: string | undefined } | null;
}): boolean {
  if (!input.current) {
    return true;
  }
  const candidate = committedAtMs(input.candidateCommittedAt);
  const current = committedAtMs(input.current.committedAt);
  if (candidate === null) {
    return false;
  }
  return current === null || candidate >= current;
}

/**
 * Existing registry entry for a slug (or null) — the ownership/sticky inputs
 * Stage 4 needs. `currentVersionStatus` is the status of the `isCurrent` version.
 */
export async function getRegistrySkillForSubmission(slug: string): Promise<
  | (NonNullable<RegistryExistingEntry> & {
      skillId: string;
      currentVersion: { id: string; storagePointer: string } | null;
    })
  | null
> {
  const [row] = await db
    .select({
      skillId: skillDefinitions.id,
      ownerUserId: skillDefinitions.ownerUserId,
      definitionStatus: skillDefinitions.status,
      currentVersionStatus: skillVersions.status,
      currentVersionId: skillVersions.id,
      currentStoragePointer: skillVersions.storagePointer,
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
    currentVersion:
      row.currentVersionId && row.currentStoragePointer
        ? {
            id: row.currentVersionId,
            storagePointer: row.currentStoragePointer,
          }
        : null,
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
  if (committedAtMs(input.manifestJson.registry?.committedAt) === null) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_UNDATED",
      "A registry version cannot be stored without its commit date",
    );
  }
  // Objects first, rows second — see the file header. Nothing below this line
  // runs unless every blob and the bundle are in object storage.
  const stored = await storeRegistrySkillObjects(input.files);
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
    // Another kind of skill holding this slug is a real conflict. Another
    // submitter of the same repository is not: see `triageRegistrySubmission`.
    if (existing && existing.sourceType !== "registry_github") {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_CONFLICT",
        "This skill belongs to another source",
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
      // A version label is immutable: the same commit and path must be the same
      // bytes. The bundle digest already covers every path and body; the
      // per-file comparison keeps the manifest rows under the same guarantee.
      const storedRows = await tx
        .select({
          path: skillVersionFiles.path,
          contentHash: skillVersionFiles.contentHash,
        })
        .from(skillVersionFiles)
        .where(eq(skillVersionFiles.skillVersionId, existingVersion.id));
      const hashes = (files: Array<{ path: string; contentHash: string }>) =>
        JSON.stringify(
          files
            .map((f) => [f.path, f.contentHash])
            .sort((a, b) => a[0]!.localeCompare(b[0]!)),
        );
      if (
        existingVersion.bundleSha256 !== stored.bundle.sha256 ||
        hashes(storedRows) !== hashes(stored.files)
      ) {
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
    if (
      existing &&
      input.featured !== undefined &&
      existing.featuredSetBy !== "admin" &&
      (existing.featured !== input.featured ||
        existing.featuredSetBy !== "sync")
    ) {
      await tx
        .update(skillDefinitions)
        .set({
          featured: input.featured,
          featuredSetBy: "sync",
          updatedAt: now,
        })
        .where(eq(skillDefinitions.id, existing.id));
    }
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
      skillMd: stored.skillMd,
      bundle: stored.bundle,
      version,
      versionStatus: decision.versionStatus,
    });
    // Read under the advisory lock, so a concurrent submission of another
    // commit has either fully landed or not started: the comparison below sees
    // a settled current version whichever transaction runs second.
    const [current] = await tx
      .select({
        id: skillVersions.id,
        version: skillVersions.version,
        status: skillVersions.status,
        bundleSha256: skillVersions.bundleSha256,
        manifestJson: skillVersions.manifestJson,
      })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.isCurrent, true),
        ),
      )
      .limit(1);
    // Byte-for-byte the skill that is current already, just at another
    // commit: not a version of its own. It would only be a duplicate with a
    // new label — listed in the versions, and announced as an update to every
    // workspace that has the old one. The newer commit is noted instead.
    if (current && current.bundleSha256 === stored.bundle.sha256) {
      const registry = current.manifestJson.registry;
      const candidateAt = input.manifestJson.registry?.committedAt;
      const seenAt = registry?.seenAt?.committedAt ?? registry?.committedAt;
      if (
        registry &&
        candidateAt &&
        (!seenAt || Date.parse(candidateAt) > Date.parse(seenAt))
      ) {
        await tx
          .update(skillVersions)
          .set({
            manifestJson: {
              ...current.manifestJson,
              registry: {
                ...registry,
                seenAt: {
                  commitSha: input.commitSha,
                  committedAt: candidateAt,
                },
              },
            },
            updatedAt: now,
          })
          .where(eq(skillVersions.id, current.id));
      }
      return {
        slug: input.slug,
        skillId,
        skillVersionId: current.id,
        version: current.version,
        status: current.status === "published" ? "indexed" : "queued",
        flags: registry?.scan.flags ?? [],
        diagnostics: registry?.ingestion?.diagnostics ?? [],
      };
    }
    const isPublished = values.version.status === "published";
    // Ancestry first — GitHub's answer to "does this commit descend from the
    // current one" — and commit dates only when that answer is not for the
    // version that is current now (another write got in between).
    const takesCurrent =
      isPublished &&
      (current && input.currency?.againstVersionId === current.id
        ? input.currency.candidateIsNewer
        : registryVersionTakesCurrent({
            candidateCommittedAt: input.manifestJson.registry?.committedAt,
            current: current
              ? { committedAt: current.manifestJson.registry?.committedAt }
              : null,
          }));
    const pointer = parseGithubStoragePointer(input.storagePointer);
    const repoOwner = pointer?.owner.toLowerCase() ?? null;
    const repoName = pointer?.repo.toLowerCase() ?? null;
    if (!existing) {
      // A repository its author has claimed: a skill it ships later is theirs
      // from the start, whoever happened to import it.
      const [claim] =
        repoOwner && repoName
          ? await tx
              .select({
                userId: skillRepoClaims.userId,
                verifiedAt: skillRepoClaims.verifiedAt,
              })
              .from(skillRepoClaims)
              .where(
                and(
                  eq(skillRepoClaims.repoOwner, repoOwner),
                  eq(skillRepoClaims.repoName, repoName),
                  eq(skillRepoClaims.status, "verified"),
                ),
              )
              .limit(1)
          : [];
      await tx.insert(skillDefinitions).values({
        id: skillId,
        ...values.definition,
        slug: input.slug,
        ownerUserId: claim?.userId ?? input.submitterId,
        repoOwner,
        repoName,
        featured: input.featured ?? false,
        featuredSetBy: input.featured === undefined ? null : "sync",
        claimedAt: claim ? (claim.verifiedAt ?? now) : null,
        createdAt: now,
        updatedAt: now,
      });
    } else if (takesCurrent) {
      // An older commit that lands late is kept as a historical version only;
      // the definition keeps describing the version users actually get.
      await tx
        .update(skillDefinitions)
        .set({
          displayName: input.displayName,
          description: input.description,
          // `verified` vouches for content: new content is not vouched for
          // until an admin looks again.
          verified: false,
          repoOwner: existing.repoOwner ?? repoOwner,
          repoName: existing.repoName ?? repoName,
          updatedAt: now,
        })
        .where(eq(skillDefinitions.id, skillId));
    }
    if (takesCurrent) {
      await tx
        .update(skillVersions)
        .set({ isCurrent: false, updatedAt: now })
        .where(eq(skillVersions.skillId, skillId));
    }
    const skillVersionId = randomUUID();
    await tx.insert(skillVersions).values({
      id: skillVersionId,
      skillId,
      ...values.version,
      isCurrent: takesCurrent,
      createdBy: input.submitterId,
      // Published is not the same as current: a late-arriving older commit is
      // published as history without taking over.
      publishedAt: isPublished ? now : null,
      createdAt: now,
      updatedAt: now,
    });
    // One manifest row per file. The bytes are the blob at `objectKey`;
    // `contentText` stays null for an `object` version.
    await tx.insert(skillVersionFiles).values(
      stored.files.map((file) => ({
        ...file,
        contentText: null,
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

/**
 * Whether the author of this GitHub repository removed it from SourceWeft: a
 * verified claim on it carries `removed_at`. Such a repository is not
 * imported again — a new skill in it would otherwise be indexed and, once
 * clean, listed as if the author had never asked.
 */
export async function isSkillRepositoryRemoved(repo: {
  owner: string;
  name: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: skillRepoClaims.id })
    .from(skillRepoClaims)
    .where(
      and(
        eq(skillRepoClaims.repoOwner, repo.owner.toLowerCase()),
        eq(skillRepoClaims.repoName, repo.name.toLowerCase()),
        eq(skillRepoClaims.status, "verified"),
        isNotNull(skillRepoClaims.removedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}
