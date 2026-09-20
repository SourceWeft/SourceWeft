import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const store = vi.hoisted(() => ({
  objects: new Map<string, { body: Buffer; contentType: string }>(),
  uploads: 0,
}));

vi.mock("../../sources/storage", () => ({
  getContentStorageBucketName: () => "bucket",
  sandboxAssetObjectExists: async ({ key }: { key: string }) =>
    store.objects.has(key),
  uploadFileObject: async (input: {
    key: string;
    body: Buffer;
    contentType: string;
  }) => {
    store.uploads += 1;
    store.objects.set(input.key, {
      body: input.body,
      contentType: input.contentType,
    });
    return { bucket: "bucket", key: input.key };
  },
  downloadFileObject: async ({ key }: { key: string }) =>
    store.objects.get(key)!.body,
  downloadSandboxAssetObject: async ({ key }: { key: string }) =>
    store.objects.get(key)!.body,
  getSandboxAssetDownloadUrl: async ({ key }: { key: string }) =>
    `https://storage.test/${key}?signed`,
}));

const storage = await import("./index");

const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  store.objects.clear();
  store.uploads = 0;
});

// Content addressing is the whole design: existence is the index, a retried
// write is a no-op, and one font shared by many versions is stored once.
test("the same bytes are stored once, under a key derived from their digest", async () => {
  const font = new Uint8Array([0, 1, 2, 255, 254]); // not valid UTF-8
  const first = await storage.putSkillBlob({
    bytes: font,
    mimeType: "font/ttf",
  });
  const again = await storage.putSkillBlob({
    bytes: font,
    mimeType: "font/ttf",
  });
  assert.deepEqual(first, again);
  assert.equal(store.uploads, 1);
  assert.equal(
    first.objectKey,
    `skills/blobs/${first.sha256.slice(0, 2)}/${first.sha256}`,
  );
  assert.deepEqual(
    new Uint8Array(await storage.readSkillBlob({ objectKey: first.objectKey })),
    font,
  );
});

// The bundle digest is the version's content hash, the storage key and the
// sandbox stamp, so it must depend on content alone.
test("a bundle's digest depends on its contents, not on file order", async () => {
  const a = { path: "SKILL.md", bytes: bytes("---\nname: x\n---\n") };
  const b = { path: "fonts/a.ttf", bytes: new Uint8Array([9, 8, 7]) };
  const one = storage.buildSkillBundleZip([a, b]);
  const two = storage.buildSkillBundleZip([b, a]);
  assert.equal(one.sha256, two.sha256);
  assert.notEqual(
    one.sha256,
    storage.buildSkillBundleZip([a, { ...b, bytes: new Uint8Array([1]) }])
      .sha256,
  );

  const stored = await storage.putSkillBundle([a, b]);
  assert.equal(stored.sha256, one.sha256);
  assert.equal(stored.objectKey, `skills/bundles/${one.sha256}.zip`);
  assert.equal(
    store.objects.get(stored.objectKey)?.contentType,
    "application/zip",
  );
  await storage.putSkillBundle([b, a]);
  assert.equal(store.uploads, 1);
  assert.match(
    await storage.presignSkillBundleUrl(stored.objectKey),
    /signed$/,
  );
});
