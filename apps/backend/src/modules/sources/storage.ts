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
  GetObjectCommand,
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

export async function uploadSourceObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: getConfiguredBucket(),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
}

export async function uploadArtifactObject(input: {
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

/**
 * The single `ArtifactStorage` implementation. Capability tools and the
 * deliverable worker host both receive this object as-is; nobody re-spells the
 * member names on the way in.
 */
export const artifactStorage: ArtifactStorage = {
  buildArtifactStorageKey,
  getBucketName: getContentStorageBucketName,
  upload: uploadArtifactObject,
  download: downloadArtifactObjectForPort,
};

export async function uploadChatImageObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: getConfiguredBucket(),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
}

export async function downloadSourceObject(input: { bucket?: string | null; key: string }) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
    }),
  );

  const bytes = await response.Body?.transformToByteArray();
  return Buffer.from(bytes ?? []);
}

export async function downloadArtifactObject(input: { bucket?: string | null; key: string }) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
    }),
  );

  const bytes = await response.Body?.transformToByteArray();
  return Buffer.from(bytes ?? []);
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
export async function downloadArtifactObjectForPort(
  input: ArtifactStorageDownloadInput,
): Promise<ArtifactStorageDownloadResult | null> {
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
    return { body: new Uint8Array(0), contentType };
  }
  if (bytes.byteLength > maxBytes) {
    throw tooLargeToDownload({
      key: input.key,
      byteLength: bytes.byteLength,
      maxBytes,
    });
  }

  return { body: bytes, contentType };
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

export async function downloadChatImageObject(input: {
  bucket?: string | null;
  key: string;
}) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
    }),
  );

  const bytes = await response.Body?.transformToByteArray();
  return Buffer.from(bytes ?? []);
}

export function getSourceObjectDownloadUrl(input: {
  bucket?: string | null;
  key: string;
  fileName: string;
  contentType: string;
  expiresInSeconds?: number;
}) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
      ResponseContentType: input.contentType,
    }),
    { expiresIn: input.expiresInSeconds ?? 15 * 60 },
  );
}

export function getSourceObjectPreviewUrl(input: {
  bucket?: string | null;
  key: string;
  fileName: string;
  contentType: string;
  expiresInSeconds?: number;
}) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
      ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
      ResponseContentType: input.contentType,
    }),
    { expiresIn: input.expiresInSeconds ?? 15 * 60 },
  );
}

export function getArtifactObjectDownloadUrl(input: {
  bucket?: string | null;
  key: string;
  fileName: string;
  contentType: string;
  expiresInSeconds?: number;
}) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: input.bucket || getConfiguredBucket(),
      Key: input.key,
      ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
      ResponseContentType: input.contentType,
    }),
    { expiresIn: input.expiresInSeconds ?? 15 * 60 },
  );
}
