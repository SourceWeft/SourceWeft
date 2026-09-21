import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import {
  downloadFileObject,
  downloadSandboxAssetObject,
  getContentStorageBucketName,
  getSandboxAssetDownloadUrl,
  sandboxAssetObjectExists,
  uploadFileObject,
} from "../../sources/storage";

/**
 * Where a skill's bytes live.
 *
 * The database keeps a skill's identity, its SKILL.md (what the catalog shows
 * and a turn loads up front) and a manifest row per file. The bytes themselves
 * are here, in object storage — the split LobeHub's skill store uses, and the
 * only one under which a skill can carry what skills actually ship: fonts,
 * images, templates. A Postgres `text` column rejects those outright, which is
 * why ingest used to drop them.
 *
 * Two kinds of object, both content-addressed, so existence IS the index and a
 * retried write is a no-op rather than a duplicate:
 * - a BLOB per file (`skills/blobs/<aa>/<sha256>`): what the model reads, one
 *   file at a time. The same font across versions and skills is stored once.
 * - a BUNDLE per version (`skills/bundles/<sha256>.zip`): the whole skill as a
 *   deterministic zip, which the sandbox downloads by presigned URL and
 *   verifies by that same digest.
 */

export { SKILL_STORAGE_LIMITS } from "./limits";
import { SKILL_STORAGE_LIMITS } from "./limits";

/** Fixed timestamp for deterministic zip output (the zip epoch is 1980). */
const ZIP_MTIME = new Date("2000-01-01T00:00:00Z");

export type SkillFileBytes = { path: string; bytes: Uint8Array };

export type StoredSkillBlob = {
  sha256: string;
  objectKey: string;
  sizeBytes: number;
};

export type StoredSkillBundle = StoredSkillBlob;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function skillBlobObjectKey(sha256: string): string {
  return `skills/blobs/${sha256.slice(0, 2)}/${sha256}`;
}

export function skillBundleObjectKey(sha256: string): string {
  return `skills/bundles/${sha256}.zip`;
}

/**
 * The whole skill as one zip whose digest depends only on its contents: sorted
 * entries, a fixed mtime and a pure-JS compressor. That is what lets the digest
 * double as the version's content hash, the storage key and the sandbox stamp.
 */
export function buildSkillBundleZip(files: readonly SkillFileBytes[]): {
  sha256: string;
  content: Uint8Array;
} {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    entries[file.path] = [file.bytes, { mtime: ZIP_MTIME }];
  }
  const content = zipSync(entries, { mtime: ZIP_MTIME });
  return { sha256: sha256Hex(content), content };
}

async function putIfAbsent(input: {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}) {
  // Content-addressed: if the key exists, the bytes are already these bytes.
  // Two racing writers upload identical content to an identical key — wasteful
  // once, never wrong — so there is nothing to lock.
  if (await sandboxAssetObjectExists({ key: input.key })) {
    return;
  }
  await uploadFileObject({
    key: input.key,
    body: Buffer.from(input.bytes),
    contentType: input.contentType,
  });
}

export async function putSkillBlob(input: {
  bytes: Uint8Array;
  mimeType: string;
}): Promise<StoredSkillBlob> {
  const sha256 = sha256Hex(input.bytes);
  const objectKey = skillBlobObjectKey(sha256);
  await putIfAbsent({
    key: objectKey,
    bytes: input.bytes,
    contentType: input.mimeType,
  });
  return { sha256, objectKey, sizeBytes: input.bytes.byteLength };
}

/** Bounded read of one file, for the model's `/skills` mount and the catalog. */
export function readSkillBlob(input: {
  objectKey: string;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  return downloadFileObject({
    bucket: getContentStorageBucketName(),
    key: input.objectKey,
    maxBytes: input.maxBytes ?? SKILL_STORAGE_LIMITS.maxFileBytes,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function putSkillBundle(
  files: readonly SkillFileBytes[],
): Promise<StoredSkillBundle> {
  const { sha256, content } = buildSkillBundleZip(files);
  const objectKey = skillBundleObjectKey(sha256);
  await putIfAbsent({
    key: objectKey,
    bytes: content,
    contentType: "application/zip",
  });
  return { sha256, objectKey, sizeBytes: content.byteLength };
}

/** Whether an object this module wrote is still there. */
export function skillObjectExists(objectKey: string): Promise<boolean> {
  return sandboxAssetObjectExists({ key: objectKey });
}

/** Short-lived URL for the sandbox's fetch rung. */
export function presignSkillBundleUrl(objectKey: string): Promise<string> {
  return getSandboxAssetDownloadUrl({ key: objectKey });
}

/** Whole bundle, for the upload rung (sandboxes with no egress). */
export function readSkillBundle(objectKey: string): Promise<Uint8Array> {
  return downloadSandboxAssetObject({ key: objectKey });
}
