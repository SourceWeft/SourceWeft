import { eq } from "drizzle-orm";
import { db, skillVersionFiles, skillVersions } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import { ContentError } from "../../content/errors";
import {
  downloadRepoZip,
  readZipEntries,
} from "../../market/parser/github-zip";
import {
  putSkillBlob,
  putSkillBundle,
  sha256Hex,
  SKILL_STORAGE_LIMITS,
} from "./index";
import { parseGithubStoragePointer } from "./source-pointer";

/**
 * Object storage is a CACHE of a community skill, not its only copy.
 *
 * A registry version is pinned to an immutable commit (`storagePointer`), and
 * the database records the sha256 of every file it was indexed with. So when an
 * object is gone — a bucket migration, a lifecycle rule, a mistake — the bytes
 * can be fetched again from the source and proven to be the same bytes: every
 * file must hash to what ingest recorded, or nothing is written. That is also
 * why this never becomes a way to swap a skill's content: upstream can vanish,
 * but it cannot change what a commit contains.
 *
 * Only versions with a GitHub pointer have a source to go back to. A
 * workspace's own skill is the authoritative copy and is never restored here.
 */

export type SkillRestoreFailure =
  "SKILL_SOURCE_NONE" | "SKILL_SOURCE_UNAVAILABLE" | "SKILL_SOURCE_MISMATCH";

export class SkillRestoreError extends ContentError {
  constructor(code: SkillRestoreFailure, message: string) {
    super(code === "SKILL_SOURCE_NONE" ? 404 : 502, code, message);
    this.name = "SkillRestoreError";
  }
}

/** S3 says "no such object" in a few dialects; all of them mean a cache miss. */
export function isStoredObjectMissing(error: unknown): boolean {
  const candidate = error as
    | { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
    | undefined;
  return (
    candidate?.name === "NoSuchKey" ||
    candidate?.name === "NotFound" ||
    candidate?.Code === "NoSuchKey" ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}

export type SkillRestoreDeps = {
  downloadZip: typeof downloadRepoZip;
  readEntries: typeof readZipEntries;
  putBlob: typeof putSkillBlob;
  putBundle: typeof putSkillBundle;
};

// Resolved when a restore actually runs, not at import: this module is reached
// from the turn's read path, and most importers never restore anything.
function defaultDeps(): SkillRestoreDeps {
  return {
    downloadZip: downloadRepoZip,
    readEntries: readZipEntries,
    putBlob: putSkillBlob,
    putBundle: putSkillBundle,
  };
}

async function restore(
  skillVersionId: string,
  deps: SkillRestoreDeps,
): Promise<void> {
  const [version] = await db
    .select({
      storageType: skillVersions.storageType,
      storagePointer: skillVersions.storagePointer,
      bundleSha256: skillVersions.bundleSha256,
    })
    .from(skillVersions)
    .where(eq(skillVersions.id, skillVersionId))
    .limit(1);
  const pointer =
    version?.storageType === "object"
      ? parseGithubStoragePointer(version.storagePointer)
      : null;
  if (!version || !pointer) {
    throw new SkillRestoreError(
      "SKILL_SOURCE_NONE",
      "This skill version has no source to restore its files from",
    );
  }

  const rows = await db
    .select({
      path: skillVersionFiles.path,
      mimeType: skillVersionFiles.mimeType,
      contentHash: skillVersionFiles.contentHash,
    })
    .from(skillVersionFiles)
    .where(eq(skillVersionFiles.skillVersionId, skillVersionId));
  const prefix = pointer.repoSubpath ? `${pointer.repoSubpath}/` : "";
  const wanted = new Map(rows.map((row) => [`${prefix}${row.path}`, row]));

  let entries: Map<string, Buffer>;
  try {
    const zip = await deps.downloadZip({
      owner: pointer.owner,
      repo: pointer.repo,
      subpath: pointer.repoSubpath,
      repoUrl: `https://github.com/${pointer.owner}/${pointer.repo}`,
      sourceUrl: `https://github.com/${pointer.owner}/${pointer.repo}/tree/${pointer.commitSha}/${pointer.repoSubpath}`,
      commitSha: pointer.commitSha,
    });
    entries = await deps.readEntries(zip, (path) => wanted.has(path), {
      maxFileBytes: SKILL_STORAGE_LIMITS.maxFileBytes,
    });
  } catch (error) {
    throw new SkillRestoreError(
      "SKILL_SOURCE_UNAVAILABLE",
      `The skill's source could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Everything is checked before anything is written: a partial restore would
  // leave a version that reads fine for one file and fails on the next.
  const files: Array<{ path: string; bytes: Buffer; mimeType: string }> = [];
  for (const [archivePath, row] of wanted) {
    const bytes = entries.get(archivePath);
    if (!bytes || sha256Hex(bytes) !== row.contentHash.toLowerCase()) {
      throw new SkillRestoreError(
        "SKILL_SOURCE_MISMATCH",
        `The source no longer matches what was indexed (${row.path})`,
      );
    }
    files.push({ path: row.path, bytes, mimeType: row.mimeType });
  }

  for (const file of files) {
    await deps.putBlob({ bytes: file.bytes, mimeType: file.mimeType });
  }
  const bundle = await deps.putBundle(
    files.map((file) => ({ path: file.path, bytes: file.bytes })),
  );
  if (version.bundleSha256 && bundle.sha256 !== version.bundleSha256) {
    // The files are back and proven; only the zip differs — the bundle builder
    // changed since ingest. The sandbox verifies the recorded digest, so say so
    // rather than let staging fail without a reason.
    logger.warn("Restored skill bundle differs from the recorded digest", {
      skillVersionId,
      recorded: version.bundleSha256,
      rebuilt: bundle.sha256,
    });
  }
  logger.info("Skill version restored from its source", {
    skillVersionId,
    files: files.length,
    commitSha: pointer.commitSha,
  });
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Re-fetches a version's files from its pinned source and writes back the ones
 * that prove identical. Concurrent callers for one version share one download.
 */
export function restoreSkillVersionFromSource(
  skillVersionId: string,
  deps: SkillRestoreDeps = defaultDeps(),
): Promise<void> {
  const running = inFlight.get(skillVersionId);
  if (running) return running;
  const started = restore(skillVersionId, deps).finally(() => {
    inFlight.delete(skillVersionId);
  });
  inFlight.set(skillVersionId, started);
  return started;
}

/**
 * Runs an object read; on a cache miss restores the version and reads once
 * more. Any other failure, and a miss that survives the restore, is the
 * caller's to see.
 */
export async function withSkillSourceRestore<T>(
  skillVersionId: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isStoredObjectMissing(error)) throw error;
    try {
      await restoreSkillVersionFromSource(skillVersionId);
    } catch (restoreError) {
      // Nothing to go back to: the miss itself is the truthful error.
      if ((restoreError as { code?: string }).code === "SKILL_SOURCE_NONE") {
        throw error;
      }
      throw restoreError;
    }
    return read();
  }
}
