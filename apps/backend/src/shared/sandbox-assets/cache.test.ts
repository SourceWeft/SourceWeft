import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  existingKeys: new Set<string>(),
  uploads: [] as Array<{ key: string; bytes: number }>,
}));

vi.mock("../../modules/sources/storage", () => ({
  buildSandboxAssetStorageKey: (input: {
    name: string;
    version: string;
    platform: string;
    sha256: string;
  }) =>
    `sandbox-assets/${input.name}/${input.version}/${input.platform}-${input.sha256.slice(0, 16)}.zip`,
  sandboxAssetObjectExists: async (input: { key: string }) =>
    storageMocks.existingKeys.has(input.key),
  uploadSandboxAssetObject: async (input: { key: string; body: Uint8Array }) => {
    storageMocks.uploads.push({ key: input.key, bytes: input.body.byteLength });
    storageMocks.existingKeys.add(input.key);
  },
  getSandboxAssetDownloadUrl: async (input: { key: string }) =>
    `https://cache.example/${input.key}?sig=test`,
  downloadSandboxAssetObject: async () => Buffer.from([1, 2, 3]),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { ensureSandboxAssetCached, presignSandboxAssetUrl } from "./cache";
import type { SandboxAssetSpec } from "./catalog";

const ARCHIVE = new Uint8Array([7, 7, 7, 7]);
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const EXPECTED_KEY = `sandbox-assets/chrome-headless-shell/149.0.7790.0/linux-x64-${ARCHIVE_SHA.slice(0, 16)}.zip`;

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
  storageMocks.existingKeys = new Set();
  storageMocks.uploads = [];
  vi.unstubAllGlobals();
});

test("an existing digest-addressed object short-circuits without touching upstream", async () => {
  storageMocks.existingKeys.add(EXPECTED_KEY);
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  const { key } = await ensureSandboxAssetCached(spec());

  assert.equal(key, EXPECTED_KEY);
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.equal(storageMocks.uploads.length, 0);
});

test("first miss mirrors from upstream, verifies sha256, and uploads once", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(ARCHIVE.slice().buffer, { status: 200 })),
  );

  const { key } = await ensureSandboxAssetCached(spec());

  assert.equal(key, EXPECTED_KEY);
  assert.deepEqual(storageMocks.uploads, [
    { key: EXPECTED_KEY, bytes: ARCHIVE.byteLength },
  ]);

  // Second call now hits the HEAD probe — no new fetch, no new upload.
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  await ensureSandboxAssetCached(spec());
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(storageMocks.uploads.length, 1);
});

test("a digest mismatch never stores a byte and does not retry that URL", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(new Uint8Array([9, 9]).buffer, { status: 200 }),
    ),
  );

  await assert.rejects(ensureSandboxAssetCached(spec()), /sha256 mismatch/u);
  assert.equal(storageMocks.uploads.length, 0);
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  assert.equal(fetchMock.mock.calls.length, 1);
});

test("transient upstream failures are retried per URL", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("read ECONNRESET");
      }
      return new Response(ARCHIVE.slice().buffer, { status: 200 });
    }),
  );

  const { key } = await ensureSandboxAssetCached(spec());
  assert.equal(key, EXPECTED_KEY);
  assert.equal(calls, 3);
});

test("presign resolves through the cache and returns a URL", async () => {
  storageMocks.existingKeys.add(EXPECTED_KEY);

  const url = await presignSandboxAssetUrl(spec());
  assert.equal(url, `https://cache.example/${EXPECTED_KEY}?sig=test`);
});
