import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createS3ObjectStore,
  ObjectReadLimitExceeded,
} from "../../src/store/object-store";
import { e2eEnabled, loadBackendEnv } from "./env";

test(
  "real R2 GET limits release the connection and missing keys retain explicit classification",
  {
    skip: !e2eEnabled,
    timeout: 90_000,
  },
  async () => {
    const env = loadBackendEnv();
    assert.ok(
      env.S3_BUCKET && env.S3_REGION,
      "explicit real object-store configuration is required",
    );
    const store = createS3ObjectStore({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY!,
      },
    });
    const prefix = `_swvol-e2e/${randomUUID()}/`;
    const key = `${prefix}bounded-reader.bin`;
    const bytes = Buffer.alloc(8192, 42);
    try {
      await store.put(key, bytes);
      await assert.rejects(
        store.get(key, { maxBytes: 4096 }),
        (error) => error instanceof ObjectReadLimitExceeded,
      );
      assert.deepEqual(
        Buffer.from((await store.get(key, { maxBytes: bytes.length }))!),
        bytes,
      );
      assert.equal(
        await store.get(`${prefix}does-not-exist`, { maxBytes: 4096 }),
        null,
      );
      assert.equal(await store.size(`${prefix}does-not-exist`), null);
    } finally {
      await store.deletePrefix(prefix);
    }
  },
);
