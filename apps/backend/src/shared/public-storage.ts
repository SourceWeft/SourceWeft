import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config";

/**
 * The public asset bucket (`PUBLIC_S3_*`): objects written here are served
 * read-only at `PUBLIC_S3_BASE_URL/<key>` by the bucket's own public hostname,
 * never through the API. Blog images and MCP catalog icons live here. The
 * private content bucket (`S3_*`, `modules/sources/storage.ts`) is for member
 * files and is never public.
 */

let publicS3Client: S3Client | null = null;

export function getPublicS3Client() {
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

/**
 * Whether a public object can be written and then addressed: a bucket to put
 * it in and a public base URL to serve it from. Deployments without the
 * public bucket (most self-hosted ones) get neither blog images nor stored
 * catalog icons; callers say so and go on without them.
 */
export function isPublicStorageConfigured() {
  return Boolean(config.publicS3.bucket && config.publicS3.baseUrl);
}

/** The URL `key` is served from. */
export function publicObjectUrl(key: string) {
  return `${config.publicS3.baseUrl}/${key}`;
}

export type PublicObjectWriter = (input: {
  key: string;
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
}) => Promise<{ bucket: string; key: string; publicUrl: string }>;

/** Write one object to the public bucket and return where it is served. */
export const putPublicObject: PublicObjectWriter = async (input) => {
  await getPublicS3Client().send(
    new PutObjectCommand({
      Bucket: config.publicS3.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl,
    }),
  );
  return {
    bucket: config.publicS3.bucket,
    key: input.key,
    publicUrl: publicObjectUrl(input.key),
  };
};

/**
 * Whether `key` already exists in the public bucket (a content-addressed
 * object never needs writing twice). Any answer but "found" is "not found":
 * the caller then writes, which is idempotent.
 */
export async function publicObjectExists(key: string): Promise<boolean> {
  try {
    await getPublicS3Client().send(
      new HeadObjectCommand({ Bucket: config.publicS3.bucket, Key: key }),
    );
    return true;
  } catch {
    return false;
  }
}
