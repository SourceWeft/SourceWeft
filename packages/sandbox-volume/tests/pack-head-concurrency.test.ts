import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import {
  validateManifest,
  type ValidationContext,
} from "../src/protocol/validate";
import { ManifestRejected } from "../src/protocol/manifest";
import type { Manifest, ChunkLocation } from "../src/protocol/types";
import { createS3ObjectStore } from "../src/store/object-store";
function input(count = 8) {
  const chunks: Record<string, ChunkLocation> = {};
  const c: Array<[string, number]> = [];
  for (let n = 0; n < count; n++) {
    const id = (n + 1).toString(16).padStart(64, "0");
    chunks[id] = [`att/a/p/${String(n).padStart(6, "0")}`, 0, 4, 4];
    c.push([id, 4]);
  }
  const manifest: Manifest = {
    v: 1,
    volume: "v",
    attachment: "a",
    boot_id: "boot",
    seq: 1,
    base: 0,
    chunks,
    upserts: [{ p: "file", k: "f", m: 420, s: count * 4, c }],
  };
  const ctx: ValidationContext = {
    volumeId: "v",
    attachmentId: "a",
    bootId: "boot",
    head: 0,
    slotsUntilPack: count,
    slotsUntilSeq: 64,
    packPrefix: "att/a/p/",
    ownKey: "att/a/m/0/1",
    rawLength: 100,
    inlineRange: [16, 16],
    chunkKnown: async () => false,
    chunkLength: async () => null,
    packSize: async () => 64,
  };
  return { manifest, ctx };
}

test(
  "real local HTTP HEAD uses four gated requests and settles every response",
  { timeout: 10000 },
  async () => {
    let count = 0,
      active = 0,
      peak = 0;
    const waiting: ServerResponse[] = [];
    const release = () => {
      for (const response of waiting.splice(0)) {
        response.writeHead(200, { "content-length": "64" });
        response.end();
        active--;
      }
    };
    let wave!: () => void;
    const firstWave = new Promise<void>((resolve) => {
      wave = resolve;
    });
    const server = createServer((request, response) => {
      assert.equal(request.method, "HEAD");
      count++;
      active++;
      peak = Math.max(peak, active);
      waiting.push(response);
      if (waiting.length === 4) {
        wave();
        release();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const store = createS3ObjectStore({
      bucket: "fixture",
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      requestTimeoutMs: 3000,
    });
    const { manifest, ctx } = input();
    ctx.packSize = (key) => store.size(key);
    const run = validateManifest(manifest, ctx);
    const outcome = run.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        firstWave,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "four real HEADs did not arrive before the gate deadline",
                ),
              ),
            2000,
          );
        }),
      ]);
      const result = await run;
      assert.equal(result.packSizes.size, 8);
      assert.equal(count, 8);
      assert.equal(peak, 4);
      assert.equal(active, 0);
    } finally {
      clearTimeout(timer);
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await outcome;
    }
  },
);

test("shared pack keys have one singleflight HEAD and every chunk extent is checked", async () => {
  const { manifest, ctx } = input(4);
  for (const loc of Object.values(manifest.chunks!)) loc[0] = "att/a/p/000000";
  let calls = 0;
  ctx.packSize = async () => {
    calls++;
    return 64;
  };
  assert.equal((await validateManifest(manifest, ctx)).packSizes.size, 1);
  assert.equal(calls, 1);
  Object.values(manifest.chunks!)[3]![1] = 63;
  await assert.rejects(validateManifest(manifest, ctx), /extends past/);
});

for (const bad of [
  "foreign",
  "unissued",
  "bounds",
  "path",
  "unknown",
  "prototype",
])
  test(`all descriptor checks precede HEAD: ${bad}`, async () => {
    const { manifest, ctx } = input(2);
    const last = Object.values(manifest.chunks!)[1]!;
    if (bad === "foreign") last[0] = "other/private";
    if (bad === "unissued") last[0] = "att/a/p/000002";
    if (bad === "bounds") last[1] = 64 * 1024 ** 2;
    if (bad === "path") manifest.upserts![0]!.p = "../outside";
    if (bad === "unknown") manifest.upserts![0]!.c![1]![0] = "f".repeat(64);
    if (bad === "prototype") {
      const id = "a".repeat(64);
      manifest.chunks = JSON.parse(
        `{"__proto__":{"${id}":["att/a/p/000000",0,1,1]}}`,
      );
      manifest.upserts = [
        { p: "inherited", k: "f", m: 420, s: 1, c: [[id, 1]] },
      ];
    }
    let calls = 0;
    ctx.packSize = async () => {
      calls++;
      return 64;
    };
    await assert.rejects(validateManifest(manifest, ctx), ManifestRejected);
    assert.equal(calls, 0);
  });

for (const size of [0, -1, NaN, Infinity, 64 * 1024 ** 2 + 1])
  test(`invalid physical HEAD size ${size} fails closed`, async () => {
    const { manifest, ctx } = input(1);
    ctx.packSize = async () => size;
    await assert.rejects(validateManifest(manifest, ctx), ManifestRejected);
  });

test("all started HEAD failures settle, with missing and transport causes retained", async () => {
  const { manifest, ctx } = input(8);
  const releases: Array<() => void> = [];
  let begun = 0,
    settled = 0,
    finished = false;
  ctx.packSize = async () => {
    const n = begun++;
    await new Promise<void>((resolve) => releases.push(resolve));
    settled++;
    if (n === 0) return null;
    if (n === 1) throw Error("synthetic transport deadline");
    if (n === 2) return 64 * 1024 ** 2 + 1;
    throw undefined;
  };
  const run = validateManifest(manifest, ctx).finally(() => {
    finished = true;
  });
  const observed = run.then(
    () => null,
    (error) => error,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(begun, 4);
  releases[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  for (const release of releases.slice(1)) release();
  const error = await observed;
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 4);
  assert.ok(error.errors.some((e: unknown) => e instanceof ManifestRejected));
  assert.ok(
    error.errors.some(
      (e: unknown) =>
        e instanceof Error && e.message.includes("transport deadline"),
    ),
  );
  assert.ok(error.errors.includes(undefined));
  assert.equal(settled, 4);
  assert.equal(begun, 4);
});

test("asynchronous HEAD callbacks cannot change already-checked manifest metadata", async () => {
  const { manifest, ctx } = input(1);
  ctx.packSize = async () => {
    manifest.full = true;
    manifest.upserts![0]!.p = "../escape";
    Object.values(manifest.chunks!)[0]![0] = "other/private";
    return 64;
  };
  const result = await validateManifest(manifest, ctx);
  assert.equal(result.manifest.full, undefined);
  assert.equal(result.manifest.upserts![0]!.p, "file");
  assert.equal(Object.values(result.newChunks)[0]![0], "att/a/p/000000");
});
test("a non-string key with a hostile JSON toString property is a preflight rejection", async () => {
  const { manifest, ctx } = input(1);
  Object.values(manifest.chunks!)[0]![0] = { toString: 1 } as unknown as string;
  let calls = 0;
  ctx.packSize = async () => {
    calls++;
    return 64;
  };
  await assert.rejects(validateManifest(manifest, ctx), ManifestRejected);
  assert.equal(calls, 0);
});
test("an unknown single callback rejection stays an explicit failure", async () => {
  const { manifest, ctx } = input(1);
  ctx.packSize = async () => {
    throw undefined;
  };
  await assert.rejects(
    validateManifest(manifest, ctx),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0] === undefined,
  );
});
test(
  "caller signal cancels all four actual pending HTTP HEADs without authorizing a manifest",
  { timeout: 10000 },
  async () => {
    let requests = 0,
      settled = 0,
      observed!: () => void;
    const four = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const server = createServer(() => {
      if (++requests === 4) observed();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const store = createS3ObjectStore({
      bucket: "fixture",
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      requestTimeoutMs: 3000,
    });
    const controller = new AbortController(),
      { manifest, ctx } = input(8);
    ctx.packSize = (key) =>
      store.size(key, { signal: controller.signal }).finally(() => {
        settled++;
      });
    const outcome = validateManifest(manifest, ctx).then(
      () => null,
      (error) => error,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        four,
        outcome.then((error) => {
          throw error ?? Error("unexpected manifest authorization");
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("four HEADs never reached the fixture")),
            2000,
          );
        }),
      ]);
      controller.abort();
      const error = await outcome;
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 4);
      assert.equal(requests, 4);
      assert.equal(settled, 4);
    } finally {
      clearTimeout(timer);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await outcome;
    }
  },
);

test("full manifests snapshot all locations before the first chunkKnown await", async () => {
  const { manifest, ctx } = input(2);
  manifest.full = true;
  let release!: () => void,
    knownCalls = 0;
  ctx.chunkKnown = async () => {
    if (knownCalls++ === 0)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return false;
  };
  const run = validateManifest(manifest, ctx);
  assert.equal(typeof release, "function");
  const locations = Object.values(manifest.chunks!);
  locations[0]![0] = "other/private";
  locations[1]![1] = 64 * 1024 ** 2;
  release();
  const result = await run;
  assert.deepEqual(Object.values(result.newChunks), [
    ["att/a/p/000000", 0, 4, 4],
    ["att/a/p/000001", 0, 4, 4],
  ]);
  assert.equal(result.packSizes.size, 2);
});
test("a malformed full location cannot become valid during chunkKnown await", async () => {
  const { manifest, ctx } = input(2);
  manifest.full = true;
  const second = Object.values(manifest.chunks!)[1]!;
  second.pop();
  let release!: () => void,
    knownCalls = 0;
  ctx.chunkKnown = async () => {
    if (knownCalls++ === 0)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return false;
  };
  const run = validateManifest(manifest, ctx);
  const rejected = assert.rejects(run, /malformed chunk record/);
  second.push(4);
  release();
  await rejected;
});
