import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../../shared/config";
import type { BlogLocale } from "./locales";

export type UploadedBlogAsset = {
  storageBucket: string;
  storageKey: string;
  publicUrl: string;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
  sourceUrlHash: string;
};

let publicS3Client: S3Client | null = null;

function getPublicS3Client() {
  if (!publicS3Client) {
    publicS3Client = new S3Client({
      region: config.publicS3.region,
      credentials:
        config.publicS3.accessKeyId && config.publicS3.secretAccessKey
          ? {
              accessKeyId: config.publicS3.accessKeyId,
              secretAccessKey: config.publicS3.secretAccessKey,
            }
          : undefined,
      endpoint: config.publicS3.endpoint || undefined,
      forcePathStyle: config.publicS3.forcePathStyle,
    });
  }

  return publicS3Client;
}

export function validatePublicS3Config() {
  const missing = [
    ["PUBLIC_S3_BUCKET", config.publicS3.bucket],
    ["PUBLIC_S3_REGION", config.publicS3.region],
    ["PUBLIC_S3_ENDPOINT", config.publicS3.endpoint],
    ["PUBLIC_S3_ACCESS_KEY_ID", config.publicS3.accessKeyId],
    ["PUBLIC_S3_SECRET_ACCESS_KEY", config.publicS3.secretAccessKey],
    ["PUBLIC_S3_BASE_URL", config.publicS3.baseUrl],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing public S3 configuration: ${missing.map(([name]) => name).join(", ")}`,
    );
  }

  const endpoint = new URL(config.publicS3.endpoint);
  if (!endpoint.hostname.endsWith(".r2.cloudflarestorage.com")) {
    throw new Error("PUBLIC_S3_ENDPOINT must point to a Cloudflare R2 endpoint");
  }

  const baseUrl = new URL(config.publicS3.baseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_S3_BASE_URL must be an HTTPS URL");
  }
}

function sanitizeFileName(fileName: string) {
  const sanitized = fileName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return sanitized || "asset";
}

function fileNameFromUrl(url: string, fallback: string) {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (segment) {
      return decodeURIComponent(segment);
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function buildStorageKey(input: {
  articleId: string;
  locale: BlogLocale;
  sha256: string;
  fileName: string;
}) {
  return [
    "blog",
    sanitizeFileName(input.articleId),
    input.locale,
    `${input.sha256}-${sanitizeFileName(input.fileName)}`,
  ].join("/");
}

export async function downloadAndUploadBlogAsset(input: {
  articleId: string;
  locale: BlogLocale;
  sourceUrl: string;
  fallbackFileName: string;
  contentTypeHint?: string | null;
}) {
  validatePublicS3Config();

  const response = await fetch(input.sourceUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download blog asset (${response.status}) from ${input.sourceUrl}`,
    );
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > config.blog.assetMaxBytes) {
    throw new Error(
      `Blog asset is too large: ${contentLength} bytes exceeds ${config.blog.assetMaxBytes}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > config.blog.assetMaxBytes) {
    throw new Error(
      `Blog asset is too large: ${arrayBuffer.byteLength} bytes exceeds ${config.blog.assetMaxBytes}`,
    );
  }

  const body = Buffer.from(arrayBuffer);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const sourceUrlHash = createHash("sha256")
    .update(input.sourceUrl)
    .digest("hex");
  const contentType =
    response.headers.get("content-type") || input.contentTypeHint || null;
  const fileName = fileNameFromUrl(input.sourceUrl, input.fallbackFileName);
  const storageKey = buildStorageKey({
    articleId: input.articleId,
    locale: input.locale,
    sha256,
    fileName,
  });

  await getPublicS3Client().send(
    new PutObjectCommand({
      Bucket: config.publicS3.bucket,
      Key: storageKey,
      Body: body,
      ContentType: contentType ?? undefined,
    }),
  );

  return {
    storageBucket: config.publicS3.bucket,
    storageKey,
    publicUrl: `${config.publicS3.baseUrl}/${storageKey}`,
    contentType,
    sizeBytes: body.byteLength,
    sha256,
    sourceUrlHash,
  } satisfies UploadedBlogAsset;
}

