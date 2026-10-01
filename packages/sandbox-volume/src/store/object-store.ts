import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGN_TTL_SECONDS } from "../protocol/constants";

/**
 * The few object-store operations the volume service needs. Keys are full bucket keys.
 * Sandboxes never see credentials: they only get pre-signed URLs produced here.
 */
export type ObjectStore = {
  /** Pre-signed PUT that succeeds only if the key does not exist yet (`If-None-Match: *` is part of the signature). */
  presignWriteOnce(key: string, ttlSeconds?: number): Promise<string>;
  presignGet(key: string, ttlSeconds?: number): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** Size in bytes, or null when the key does not exist. */
  size(key: string): Promise<number | null>;
  /** Server-side copy (used to repair packs that will not download from a sandbox). */
  copy(fromKey: string, toKey: string): Promise<void>;
  /** Delete every object under a prefix; returns the number deleted (GC and test cleanup). */
  deletePrefix(prefix: string): Promise<number>;
};

export type S3ObjectStoreConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
};

export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
  };
  const client = new S3Client(clientConfig);
  const bucket = config.bucket;
  return {
    async presignWriteOnce(key, ttlSeconds = PRESIGN_TTL_SECONDS) {
      // The conditional header is signed, so a client that omits it gets 403 and one that
      // sends it against an existing object gets 412: a slot can be written exactly once.
      const command = new PutObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: "*" });
      return getSignedUrl(client, command, { expiresIn: ttlSeconds, signableHeaders: new Set(["host", "if-none-match"]) });
    },
    async presignGet(key, ttlSeconds = PRESIGN_TTL_SECONDS) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds });
    },
    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!response.Body) return null;
        return await response.Body.transformToByteArray();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async put(key, body, contentType = "application/octet-stream") {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async size(key) {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return response.ContentLength ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async deletePrefix(prefix) {
      let deleted = 0;
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length) {
          await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
          deleted += keys.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return deleted;
    },
    async copy(fromKey, toKey) {
      await client.send(new CopyObjectCommand({ Bucket: bucket, Key: toKey, CopySource: `/${bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}` }));
    },
  };
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}
