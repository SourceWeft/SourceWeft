import { randomUUID } from "node:crypto";
import { sanitizeArtifactStorageSegment } from "@sourceweft/contracts/artifact-files";
import {
  ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
  type ArtifactStorage,
  type ArtifactStorageDownloadInput,
  type ArtifactStorageDownloadResult,
} from "@sourceweft/contracts/artifact-storage";
import {
  ARTIFACT_WRITE_ERROR_CODES,
  ArtifactError,
} from "@sourceweft/contracts/artifact-errors";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../shared/config";

function getConfiguredBucket() {
  const bucket = config.s3.bucket;
  if (!bucket) {
    throw new Error("S3 bucket is not configured");
  }

  return bucket;
}

export function getContentStorageBucketName() {
  return getConfiguredBucket();
}

const s3Client = new S3Client({
  region: config.s3.region,
  credentials:
    config.s3.accessKeyId && config.s3.secretAccessKey
      ? {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        }
      : undefined,
  endpoint: config.s3.endpoint || undefined,
  forcePathStyle: config.s3.forcePathStyle,
});

/**
 * Object keys stay ASCII even though the display file name may not: the shared
 * sanitizer preserves unicode for `Content-Disposition` (which encodes it), and
 * this is the pass that keeps it out of the key itself.
 */
function storageKeyFileName(fileName: string) {
  return sanitizeArtifactStorageSegment(fileName, {
    fallback: "file",
    maxLength: 120,
  });
}

export function buildSourceStorageKey(input: {
  workspaceId: string;
  sourceId: string;
  fileName: string;
}) {
  const sanitizedName = storageKeyFileName(input.fileName);
  return `workspaces/${input.workspaceId}/sources/${input.sourceId}/${randomUUID()}-${sanitizedName}`;
}

export function buildArtifactStorageKey(input: {
  workspaceId: string;
  artifactId: string;
  fileName: string;
}) {
  const sanitizedName = storageKeyFileName(input.fileName);
  return `workspaces/${input.workspaceId}/artifacts/${input.artifactId}/${randomUUID()}-${sanitizedName}`;
}

export function buildChatImageStorageKey(input: {
  workspaceId: string;
  messageId: string;
  imageId: string;
  fileName: string;
}) {
  const sanitizedName = storageKeyFileName(input.fileName);
  return `workspaces/${input.workspaceId}/chat-images/${input.messageId}/${input.imageId}-${randomUUID()}-${sanitizedName}`;
}

/**
 * The one write. Every named upload below is this call with a different name,
 * which is all the callers ever needed them to be.
 */
async function putObject(input: {
  key: string;
  body: Uint8Array;
  contentType: string;
  signal?: AbortSignal;
}) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: getConfiguredBucket(),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
    { abortSignal: input.signal },
  );
}

export type ArtifactObjectPutIfAbsentResult = "created" | "exists";

function isConditionalObjectAlreadyPresent(error: unknown) {
  const name = (error as { name?: unknown } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)
    ?.$metadata?.httpStatusCode;
  return name === "PreconditionFailed" || status === 412;
}

function isConditionalObjectConflict(error: unknown) {
  const name = (error as { name?: unknown } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)
    ?.$metadata?.httpStatusCode;
  return name === "ConditionalRequestConflict" || status === 409;
}

/**
 * Atomically creates an immutable object using S3's real conditional-write
 * precondition. A concurrent 409 is retried with the same precondition; this
 * function never falls back to a HEAD-then-unconditional-PUT sequence.
 */
export async function putArtifactObjectIfAbsent(input: {
  key: string;
  body: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<ArtifactObjectPutIfAbsentResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: getConfiguredBucket(),
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          IfNoneMatch: "*",
          ...(input.metadata ? { Metadata: input.metadata } : {}),
        }),
        { abortSignal: input.signal },
      );
      return "created";
    } catch (error) {
      if (isConditionalObjectAlreadyPresent(error)) {
        return "exists";
      }
      if (attempt === 0 && isConditionalObjectConflict(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Conditional artifact object write exhausted its retry");
}

/**
 * The one read. `bucket` falls back to the configured one so callers can pass
 * through a stored bucket column that may predate the current configuration.
 */
async function getObjectBuffer(input: { bucket?: string | null; key: string }) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
    }),
  );

  const bytes = await response.Body?.transformToByteArray();
  return Buffer.from(bytes ?? []);
}

export async function uploadSourceObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
  await putObject(input);
}

export async function uploadArtifactObject(input: {
  key: string;
  body: Uint8Array;
  contentType: string;
  signal?: AbortSignal;
}) {
  await putObject(input);
}

/**
 * The single `ArtifactStorage` implementation. Capability tools and the
 * deliverable worker host both receive this object as-is; nobody re-spells the
 * member names on the way in.
 */
export const artifactStorage: ArtifactStorage = {
  buildArtifactStorageKey,
  getBucketName: getContentStorageBucketName,
  upload: uploadArtifactObject,
  delete: deleteArtifactObject,
  download: downloadArtifactObjectForPort,
};

export async function uploadChatImageObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
  await putObject(input);
}

export function downloadSourceObject(input: {
  bucket?: string | null;
  key: string;
}) {
  return getObjectBuffer(input);
}

/**
 * The one delete. An already-absent key is success — S3 deletes are idempotent
 * and the caller's goal (the bytes are gone) is met either way. Anything else
 * propagates exactly as the store raised it, matching the read/write helpers.
 */
export async function deleteArtifactObject(input: {
  bucket?: string | null;
  key: string;
}) {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
    }),
  );
}

const PREFIX_DELETE_MAX_OBJECTS = 10_000;
const S3_DELETE_BATCH_SIZE = 1_000;

/**
 * Deletes one already-scoped object prefix. Keys are fully listed under a hard
 * bound before deletion starts, so a malformed/broad prefix cannot cause an
 * unbounded or partially-discovered destructive operation.
 */
export async function deleteArtifactObjectsByPrefix(input: {
  prefix: string;
  maxObjects?: number;
}) {
  const prefix = input.prefix.trim();
  if (
    !prefix ||
    prefix !== input.prefix ||
    prefix === "/" ||
    prefix.length > 1_024 ||
    prefix.includes("\0") ||
    !prefix.endsWith("/")
  ) {
    throw new Error(
      "A canonical non-empty scoped storage prefix ending in '/' is required",
    );
  }
  const requestedMaxObjects = input.maxObjects ?? PREFIX_DELETE_MAX_OBJECTS;
  if (!Number.isSafeInteger(requestedMaxObjects) || requestedMaxObjects <= 0) {
    throw new Error(
      "Scoped storage cleanup maxObjects must be a positive integer",
    );
  }
  const maxObjects = Math.min(requestedMaxObjects, PREFIX_DELETE_MAX_OBJECTS);
  const keys: string[] = [];
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;
  let pagesRead = 0;
  do {
    pagesRead += 1;
    if (pagesRead > Math.ceil(maxObjects / S3_DELETE_BATCH_SIZE) + 1) {
      throw new Error("Scoped storage cleanup exceeded its page limit");
    }
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: getConfiguredBucket(),
        Prefix: prefix,
        MaxKeys: S3_DELETE_BATCH_SIZE,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    for (const item of response.Contents ?? []) {
      if (!item.Key || !item.Key.startsWith(prefix)) {
        continue;
      }
      keys.push(item.Key);
      if (keys.length > maxObjects) {
        throw new Error(
          `Scoped storage cleanup exceeds the ${maxObjects} object limit`,
        );
      }
    }
    if (!response.IsTruncated) {
      continuationToken = undefined;
      break;
    }
    const nextToken = response.NextContinuationToken;
    if (!nextToken || seenTokens.has(nextToken)) {
      throw new Error(
        "Scoped storage cleanup received an invalid continuation token",
      );
    }
    seenTokens.add(nextToken);
    continuationToken = nextToken;
  } while (continuationToken);

  for (let offset = 0; offset < keys.length; offset += S3_DELETE_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + S3_DELETE_BATCH_SIZE);
    const response = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: getConfiguredBucket(),
        Delete: {
          Quiet: true,
          Objects: batch.map((key) => ({ Key: key })),
        },
      }),
    );
    if ((response.Errors?.length ?? 0) > 0) {
      throw new Error(
        `Scoped storage cleanup failed for ${response.Errors!.length} object(s)`,
      );
    }
  }
}

export function downloadArtifactObject(input: {
  bucket?: string | null;
  key: string;
}) {
  return getObjectBuffer(input);
}

/** What the store recorded no content type for. Never left absent — see the port. */
const DEFAULT_DOWNLOAD_CONTENT_TYPE = "application/octet-stream";

/**
 * "The key is not there", as S3 and the S3-compatible stores report it.
 *
 * Checked by name and status rather than by class: the error crosses the SDK's
 * own error hierarchy and MinIO/R2 do not always produce the same subclass. A
 * missing *bucket* is deliberately not folded in — that is a misconfigured
 * deployment, not an absent object, and swallowing it as `null` would let the
 * caller report "no audio" for what is really a broken environment.
 */
function isMissingObjectError(error: unknown) {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NoSuchKey" || name === "NotFound") {
    return true;
  }
  if (name === "NoSuchBucket") {
    return false;
  }
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)
    ?.$metadata?.httpStatusCode;
  return status === 404;
}

/**
 * The `ArtifactStorage.download` implementation.
 *
 * Kept separate from `downloadArtifactObject` above rather than replacing it:
 * that one is the app's own Buffer-returning helper with a dozen internal
 * callers that neither want the content type nor tolerate `null`. This is the
 * port's shape, which does.
 *
 * The ceiling is enforced twice on purpose. `ContentLength` is the enforcement
 * that matters — it refuses before a single byte is buffered — and the check
 * after `transformToByteArray` is only the backstop for a store that omitted
 * the header, where the bytes are unavoidably already in the heap.
 */
export async function downloadArtifactObjectWithMetadata(
  input: ArtifactStorageDownloadInput,
): Promise<
  | (ArtifactStorageDownloadResult & {
      metadata: Record<string, string>;
    })
  | null
> {
  // A caller may only tighten the ceiling; `Math.min` is what makes the port's
  // constant a ceiling instead of a default.
  const maxBytes = Math.min(
    input.maxBytes ?? ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
    ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
  );

  let response: GetObjectCommandOutput;
  try {
    response = await s3Client.send(
      new GetObjectCommand({
        Bucket: input.bucket || getConfiguredBucket(),
        Key: input.key,
      }),
    );
  } catch (error) {
    if (isMissingObjectError(error)) {
      return null;
    }
    // Everything else propagates exactly as the store raised it, the same as
    // `uploadArtifactObject` — this module has never wrapped transport faults,
    // and the write path already classifies them where it catches them.
    throw error;
  }

  const contentType = response.ContentType || DEFAULT_DOWNLOAD_CONTENT_TYPE;
  const declaredLength =
    typeof response.ContentLength === "number" ? response.ContentLength : null;
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw tooLargeToDownload({
      key: input.key,
      byteLength: declaredLength,
      maxBytes,
    });
  }

  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) {
    // The object exists (the GET succeeded); the store just handed back no
    // stream. That is emptiness, not absence, so it must not read as `null`.
    return {
      body: new Uint8Array(0),
      contentType,
      metadata: response.Metadata ?? {},
    };
  }
  if (bytes.byteLength > maxBytes) {
    throw tooLargeToDownload({
      key: input.key,
      byteLength: bytes.byteLength,
      maxBytes,
    });
  }

  return {
    body: bytes,
    contentType,
    metadata: response.Metadata ?? {},
  };
}

/** Bounded S3 range read used by immutable media streaming. */
export async function downloadArtifactObjectRange(input: {
  bucket?: string | null;
  key: string;
  start: number;
  end: number;
  totalLength: number;
}) {
  const expectedLength = input.end - input.start + 1;
  if (
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    input.start < 0 ||
    input.end < input.start ||
    expectedLength > ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES ||
    input.end >= input.totalLength
  ) {
    throw new Error("ARTIFACT_STORAGE_RANGE_INVALID");
  }
  let response: GetObjectCommandOutput;
  try {
    response = await s3Client.send(
      new GetObjectCommand({
        Bucket: input.bucket || getConfiguredBucket(),
        Key: input.key,
        Range: `bytes=${input.start}-${input.end}`,
      }),
    );
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
  if (
    typeof response.ContentLength === "number" &&
    response.ContentLength !== expectedLength
  ) {
    throw new Error("ARTIFACT_STORAGE_RANGE_LENGTH_MISMATCH");
  }
  if (
    response.ContentRange !==
    `bytes ${input.start}-${input.end}/${input.totalLength}`
  ) {
    throw new Error("ARTIFACT_STORAGE_RANGE_IDENTITY_MISMATCH");
  }
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes || bytes.byteLength !== expectedLength) {
    throw new Error("ARTIFACT_STORAGE_RANGE_LENGTH_MISMATCH");
  }
  return {
    body: bytes,
    contentType: response.ContentType || DEFAULT_DOWNLOAD_CONTENT_TYPE,
  };
}

export async function downloadArtifactObjectForPort(
  input: ArtifactStorageDownloadInput,
): Promise<ArtifactStorageDownloadResult | null> {
  const result = await downloadArtifactObjectWithMetadata(input);
  return result ? { body: result.body, contentType: result.contentType } : null;
}

/**
 * Reuses `ARTIFACT_ATTACHMENT_TOO_LARGE` rather than minting a code. Error code
 * strings here are permanent, and this situation — "an artifact attachment
 * exceeded the limit for its kind" — is the one that code already names; the
 * only new thing is which direction the bytes were moving. It classifies as
 * `validation`, correctly: the caller can pass a smaller `maxBytes` or not ask
 * for this object, which is more than it can do about a dead dependency.
 */
function tooLargeToDownload(input: {
  key: string;
  byteLength: number;
  maxBytes: number;
}) {
  return new ArtifactError({
    code: ARTIFACT_WRITE_ERROR_CODES.attachmentTooLarge,
    details: `Stored object ${input.key} is ${input.byteLength} bytes, over the ${input.maxBytes} byte download ceiling`,
  });
}

export function downloadChatImageObject(input: {
  bucket?: string | null;
  key: string;
}) {
  return getObjectBuffer(input);
}

/** How long every presigned source URL this module hands out stays valid. */
const PRESIGNED_URL_TTL_SECONDS = 15 * 60;

/**
 * Sandbox runtime-asset cache objects
 * (docs/architecture/sandbox-runtime-assets.md): immutable archives mirrored
 * from their upstream. Deliberately outside any workspace prefix — these are
 * platform-global, not tenant content.
 *
 * The sha256 prefix in the key is what makes object storage itself the cache
 * index: uploads happen only after full-digest verification, so *existence of
 * the key implies content identity* — no database row needed. A spec whose
 * digest changes (which immutability forbids, but defensively) derives a
 * different key and simply misses.
 */
export function buildSandboxAssetStorageKey(input: {
  name: string;
  version: string;
  platform: string;
  sha256: string;
}) {
  return `sandbox-assets/${input.name}/${input.version}/${input.platform}-${input.sha256.slice(0, 16)}.zip`;
}

/** HEAD probe — the cache's entire "is it mirrored yet?" check. */
export async function sandboxAssetObjectExists(input: {
  key: string;
}): Promise<boolean> {
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: getConfiguredBucket(),
        Key: input.key,
      }),
    );
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === "NotFound") {
      return false;
    }
    throw error;
  }
}

export async function uploadSandboxAssetObject(input: {
  key: string;
  body: Uint8Array;
}) {
  await putObject({
    key: input.key,
    body: input.body,
    contentType: "application/zip",
  });
}

export function getSandboxAssetDownloadUrl(input: {
  bucket?: string | null;
  key: string;
}) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS },
  );
}

/**
 * Whole-archive read for the runtime-asset *upload* rung — the universal
 * fallback transport for zero-egress sandboxes. Uncapped on purpose (assets
 * run to ~200MB); callers hold exactly one asset in memory at a time.
 */
export function downloadSandboxAssetObject(input: {
  bucket?: string | null;
  key: string;
}) {
  return getObjectBuffer(input);
}

export function getSourceObjectDownloadUrl(input: {
  bucket?: string | null;
  key: string;
  fileName: string;
  contentType: string;
}) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
      ResponseContentType: input.contentType,
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS },
  );
}

export function getSourceObjectPreviewUrl(input: {
  bucket?: string | null;
  key: string;
  fileName: string;
  contentType: string;
}) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
      ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
      ResponseContentType: input.contentType,
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS },
  );
}

/**
 * Shorter than the read TTL on purpose. A client that asked for an upload slot
 * is expected to start the PUT immediately, and a leaked write URL grants far
 * more than a leaked read URL: it is a blind write into one workspace-scoped
 * key until it expires.
 */
const PRESIGNED_UPLOAD_URL_TTL_SECONDS = 10 * 60;

/**
 * The browser's write grant for the direct-to-object-store upload path.
 *
 * The key is always built server-side (`buildSourceStorageKey`) and signed into
 * the URL, so the client can only write the one object the server chose for it.
 * `ContentType` is signed too: the browser must send exactly the header the
 * server classified, which keeps the stored object's type consistent with the
 * source record without trusting anything the client says afterwards.
 */
export function getSourceObjectUploadUrl(input: {
  key: string;
  contentType: string;
}) {
  return getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: getConfiguredBucket(),
      Key: input.key,
      ContentType: input.contentType,
    }),
    { expiresIn: PRESIGNED_UPLOAD_URL_TTL_SECONDS },
  );
}

/**
 * What the store actually holds at `key`, or `null` when nothing does.
 *
 * This is the direct-upload path's only source of truth about size and type:
 * the client PUTs straight to the store, so the size it declared at intent time
 * is a claim, not a fact. A missing object is the ordinary "client never
 * finished" case and reads as `null` rather than throwing.
 */
export async function headSourceObject(input: {
  bucket?: string | null;
  key: string;
}): Promise<{
  contentLength: number | null;
  contentType: string | null;
} | null> {
  try {
    const response = await s3Client.send(
      new HeadObjectCommand({
        Bucket: input.bucket || getConfiguredBucket(),
        Key: input.key,
      }),
    );
    return {
      contentLength:
        typeof response.ContentLength === "number"
          ? response.ContentLength
          : null,
      contentType: response.ContentType ?? null,
    };
  } catch (error) {
    if (isMissingObjectError(error)) {
      return null;
    }
    throw error;
  }
}
