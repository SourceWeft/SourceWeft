import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@sourceweft/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbState.rows,
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (input: { set: Record<string, unknown> }) => {
          dbState.upserts.push({ ...values, ...input.set });
        },
      }),
    }),
  },
  sandboxAssetCache: {
    name: "name",
    version: "version",
    platform: "platform",
    status: "status",
    storageBucket: "storage_bucket",
    storageKey: "storage_key",
  },
}));

const storageMocks = vi.hoisted(() => ({
  uploads: [] as Array<{ key: string; bytes: number }>,
}));

vi.mock("../../modules/sources/storage", () => ({
  buildSandboxAssetStorageKey: (input: {
    name: string;
    version: string;
    platform: string;
  }) => `sandbox-assets/${input.name}/${input.version}/${input.platform}.zip`,
  getContentStorageBucketName: () => "test-bucket",
  uploadSandboxAssetObject: async (input: { key: string; body: Uint8Array }) => {
    storageMocks.uploads.push({ key: input.key, bytes: input.body.byteLength });
  },
  getSandboxAssetDownloadUrl: async (input: { key: string }) =>
    `https://cache.example/${input.key}?sig=test`,
  downloadSandboxAssetObject: async () => Buffer.from([1, 2, 3]),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  ensureSandboxAssetCached,
  presignSandboxAssetUrl,
} from "./cache";
import type { SandboxAssetSpec } from "./catalog";

const ARCHIVE = new Uint8Array([7, 7, 7, 7]);
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");

function spec(overrides: Partial<SandboxAssetSpec> = {}): SandboxAssetSpec {
  return {
    name: "chrome-headless-shell",
    version: "149.0.7790.0",
    platform: "linux-x64",
    sha256: ARCHIVE_SHA,
    archive: "zip",
    entrypoint: "chrome-headless-shell-linux64/chrome-headless-shell",
    upstreamUrls: ["https://upstream.example/a.zip"],
    ...overrides,
  };
}

beforeEach(() => {
  dbState.rows = [];
  dbState.upserts = [];
  storageMocks.uploads = [];
  vi.unstubAllGlobals();
});

test("a ready row short-circuits without touching upstream", async () => {
  dbState.rows = [
    {
      status: "ready",
      storageBucket: "test-bucket",
      storageKey: "sandbox-assets/x.zip",
    },
  ];
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  const location = await ensureSandboxAssetCached(spec());

  assert.equal(location.key, "sandbox-assets/x.zip");
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.equal(dbState.upserts.length, 0);
});

test("first miss mirrors from upstream, verifies sha256, and marks ready", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(ARCHIVE.slice().buffer, { status: 200 })),
  );

  const location = await ensureSandboxAssetCached(spec());

  assert.equal(
    location.key,
    "sandbox-assets/chrome-headless-shell/149.0.7790.0/linux-x64.zip",
  );
  assert.equal(storageMocks.uploads.length, 1);
  assert.equal(storageMocks.uploads[0]?.bytes, ARCHIVE.byteLength);
  const statuses = dbState.upserts.map((upsert) => upsert.status);
  assert.deepEqual(statuses, ["pending", "ready"]);
});

test("a digest mismatch fails the row and never stores a byte", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(new Uint8Array([9, 9]).buffer, { status: 200 }),
    ),
  );

  await assert.rejects(
    ensureSandboxAssetCached(spec()),
    /sha256 mismatch/u,
  );
  assert.equal(storageMocks.uploads.length, 0);
  assert.equal(dbState.upserts.at(-1)?.status, "failed");
  // Mismatch is not transient: exactly one request, no retries on that URL.
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  assert.equal(fetchMock.mock.calls.length, 1);
});

test("a previously failed row is retried, not sticky", async () => {
  dbState.rows = [{ status: "failed", storageBucket: null, storageKey: null }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(ARCHIVE.slice().buffer, { status: 200 })),
  );

  const location = await ensureSandboxAssetCached(spec());

  assert.match(location.key, /linux-x64\.zip$/u);
  assert.equal(dbState.upserts.at(-1)?.status, "ready");
});

test("presign resolves through the cache and returns a URL", async () => {
  dbState.rows = [
    {
      status: "ready",
      storageBucket: "test-bucket",
      storageKey: "sandbox-assets/k.zip",
    },
  ];

  const url = await presignSandboxAssetUrl(spec());
  assert.equal(url, "https://cache.example/sandbox-assets/k.zip?sig=test");
});
