import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
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
  get(key: string, options?: { maxBytes: number }): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** Size in bytes, or null when the key does not exist. */
  size(key: string): Promise<number | null>;
  /** Server-side copy (used to repair packs that will not download from a sandbox). */
  copy(fromKey: string, toKey: string): Promise<void>;
  /** Delete every object under a prefix; returns the number deleted (GC and test cleanup). */
  deletePrefix(prefix: string): Promise<number>;
  /** Delete one explicitly authorized object; used only after maintenance claims it. */
  deleteObject?(key: string): Promise<void>;
};

export type S3ObjectStoreConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** End-to-end deadline for each object operation, including response streaming and SDK retries. */
  requestTimeoutMs?: number;
  credentials?: { accessKeyId: string; secretAccessKey: string };
};

/** An object is present but exceeds the caller's resource budget; never "not found". */
export class ObjectReadLimitExceeded extends Error {
  override readonly name = "ObjectReadLimitExceeded";
  constructor(readonly maxBytes: number) {
    super(`object exceeds the read size limit (${maxBytes} bytes)`);
  }
}

export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined
      ? { forcePathStyle: config.forcePathStyle }
      : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
  };
  const requestTimeoutMs = config.requestTimeoutMs ?? 60_000;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 2_147_483_647
  )
    throw new Error("invalid object-store request timeout");
  const requestOptions = () => ({
    abortSignal: AbortSignal.timeout(requestTimeoutMs),
  });
  const client = new S3Client(clientConfig);
  const bucket = config.bucket;
  return {
    async presignWriteOnce(key, ttlSeconds = PRESIGN_TTL_SECONDS) {
      // The conditional header is signed, so a client that omits it gets 403 and one that
      // sends it against an existing object gets 412: a slot can be written exactly once.
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        IfNoneMatch: "*",
      });
      return getSignedUrl(client, command, {
        expiresIn: ttlSeconds,
        signableHeaders: new Set(["host", "if-none-match"]),
      });
    },
    async presignGet(key, ttlSeconds = PRESIGN_TTL_SECONDS) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: ttlSeconds },
      );
    },
    async get(key, options) {
      const maxBytes = options?.maxBytes;
      if (
        maxBytes !== undefined &&
        (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      )
        throw new Error("invalid object read size limit");
      const controller = new AbortController();
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          {
            abortSignal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(requestTimeoutMs),
            ]),
          },
        );
        if (!response.Body) throw new Error("object response has no body");
        if (maxBytes === undefined)
          return await response.Body.transformToByteArray();
        const reader = response.Body.transformToWebStream().getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          if (
            response.ContentLength !== undefined &&
            response.ContentLength > maxBytes
          )
            throw new ObjectReadLimitExceeded(maxBytes);
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength > maxBytes - size)
              throw new ObjectReadLimitExceeded(maxBytes);
            size += value.byteLength;
            chunks.push(value);
          }
          if (
            response.ContentLength !== undefined &&
            size !== response.ContentLength
          )
            throw new Error(
              "object response length does not match its declaration",
            );
          return Buffer.concat(chunks, size);
        } finally {
          // Cancelling the stream releases its connection even when a peer keeps sending.
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      } catch (error) {
        controller.abort();
        // GET has a structured NoSuchKey error. Generic NotFound may be an HTML
        // gateway response and must not silently terminate the WAL chain.
        if (isNotFound(error, "get")) return null;
        throw error;
      }
    },
    async put(key, body, contentType = "application/octet-stream") {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
        requestOptions(),
      );
    },
    async size(key) {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
          requestOptions(),
        );
        return response.ContentLength ?? null;
      } catch (error) {
        if (isNotFound(error, "head")) return null;
        throw error;
      }
    },
    async deleteObject(key) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        requestOptions(),
      );
    },
    async deletePrefix(prefix) {
      let deleted = 0;
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
          requestOptions(),
        );
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length) {
          const result = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys, Quiet: true },
            }),
            requestOptions(),
          );
          if (result.Errors?.length) {
            const codes = [
              ...new Set(result.Errors.map((error) => error.Code ?? "Unknown")),
            ];
            throw new Error(
              `object cleanup was incomplete: ${result.Errors.length} objects failed (${codes.join(",")})`,
            );
          }
          deleted += keys.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return deleted;
    },
    async copy(fromKey, toKey) {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: toKey,
          CopySource: `/${bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
        }),
        requestOptions(),
      );
    },
  };
}

function isNotFound(error: unknown, operation: "get" | "head"): boolean {
  const name = (error as { name?: string })?.name;
  // A missing bucket or a gateway's unrelated 404 is a storage failure, not an empty WAL.
  // HEAD cannot carry an XML error body; retain its existing missing-key contract.
  return name === "NoSuchKey" || (operation === "head" && name === "NotFound");
}
