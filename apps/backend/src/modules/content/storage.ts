import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../shared/config";

function getConfiguredBucket() {
  const bucket = config.s3.bucket || process.env.S3_BUCKET || "";
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

export function buildSourceStorageKey(input: {
  workspaceId: string;
  sourceId: string;
  fileName: string;
}) {
  const sanitizedName = input.fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `workspaces/${input.workspaceId}/sources/${input.sourceId}/${randomUUID()}-${sanitizedName}`;
}

export function buildArtifactStorageKey(input: {
  workspaceId: string;
  artifactId: string;
  fileName: string;
}) {
  const sanitizedName = input.fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `workspaces/${input.workspaceId}/artifacts/${input.artifactId}/${randomUUID()}-${sanitizedName}`;
}

export function buildChatImageStorageKey(input: {
  workspaceId: string;
  messageId: string;
  imageId: string;
  fileName: string;
}) {
  const sanitizedName = input.fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
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
