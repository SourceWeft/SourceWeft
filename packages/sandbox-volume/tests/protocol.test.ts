import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  EXIT_INSTANCE_CHANGED,
  ManifestRejected,
  encodeManifestObject,
  isValidVolumePath,
  parseCommandOutput,
  parseManifestObject,
  validateManifest,
  type ChunkLocation,
  type Manifest,
  type ValidationContext,
} from "../src/protocol/index";

const VOLUME = "vol0123456789";
const ATTACHMENT = "att0123456789";
const PACK_PREFIX = `att/${ATTACHMENT}/p/`;
const OWN_KEY = `att/${ATTACHMENT}/m/0/1`;
const CHUNK_A = "a".repeat(64);
const CHUNK_B = "b".repeat(64);
const KNOWN = "c".repeat(64);

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    volumeId: VOLUME,
    attachmentId: ATTACHMENT,
    head: 0,
    packPrefix: PACK_PREFIX,
    ownKey: OWN_KEY,
    rawLength: 4096,
    inlineRange: [16, 1040],
    chunkKnown: async (id) => id === KNOWN,
    packSize: async (key) => (key === `${PACK_PREFIX}000000` ? 2048 : null),
    ...overrides,
  };
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    v: 1,
    volume: VOLUME,
    attachment: ATTACHMENT,
    seq: 1,
    base: 0,
    trigger: "flush",
    upserts: [
      { p: "src/app.ts", k: "f", m: 0o644, t: 1_700_000_000_000_000_000, s: 1234, c: [[CHUNK_A, 1234]] },
      { p: "src", k: "d", m: 0o755 },
      { p: "link", k: "l", m: 0o777, l: "src/app.ts" },
    ],
    deletes: ["old/file.txt"],
    chunks: { [CHUNK_A]: [`${PACK_PREFIX}000000`, 0, 812, 1234] },
    packs: [[`${PACK_PREFIX}000000`, 2048]],
    ...overrides,
  };
}

test("volume paths: relative, clean, outside the helper's state", () => {
  for (const ok of ["a", "a/b.txt", "node_modules/.bin/x", "中文/路径 带空格.md", ".env", ".git/HEAD"]) {
    assert.equal(isValidVolumePath(ok), true, ok);
  }
  for (const bad of ["", "/abs", "a/", "a//b", "./a", "a/../b", "..", "a\\b", "a\u0000b", "a\nb", ".sourceweft", ".sourceweft-x/y", ".sourceweft/state"]) {
    assert.equal(isValidVolumePath(bad), false, JSON.stringify(bad));
  }
  assert.equal(isValidVolumePath("x".repeat(4097)), false);
});

test("manifest object round-trips through the wire layout", () => {
  const inline = Buffer.from("inline-bytes");
  const raw = encodeManifestObject(manifest(), inline);
  const parsed = parseManifestObject(raw);
  assert.equal(parsed.manifest.seq, 1);
  assert.deepEqual(parsed.inlineRange, [16, 16 + inline.length]);
  assert.equal(parsed.rawLength, raw.length);
  assert.throws(() => parseManifestObject(Buffer.from("not a manifest at all, really")), ManifestRejected);
  const truncated = Buffer.from(raw);
  truncated.writeBigUInt64LE(BigInt(raw.length), 8);
  assert.throws(() => parseManifestObject(truncated), /inline section longer/);
});

test("tail marker is stripped and decoded; absence is reported", () => {
  const parsed = parseCommandOutput('hello\nworld\n__SWVOL__ 0 {"ok":true,"seq":7}\n');
  assert.equal(parsed.output, "hello\nworld");
  assert.equal(parsed.flushExitCode, 0);
  assert.deepEqual(parsed.flush, { ok: true, seq: 7 });
  assert.equal(parsed.instanceChanged, false);
  const changed = parseCommandOutput(`\n__SWVOL__ ${EXIT_INSTANCE_CHANGED} {}\n`);
  assert.equal(changed.instanceChanged, true);
  assert.equal(changed.output, "");
  const none = parseCommandOutput("plain output");
  assert.equal(none.markerFound, false);
  assert.equal(none.flushExitCode, null);
  const garbage = parseCommandOutput("x\n__SWVOL__ 0 {not json");
  assert.deepEqual(garbage.flush, { raw: "{not json" });
});

test("a well-formed manifest is accepted and new chunks resolved against their packs", async () => {
  const result = await validateManifest(manifest(), context());
  assert.deepEqual([...result.packSizes.entries()], [[`${PACK_PREFIX}000000`, 2048]]);
  assert.deepEqual(Object.keys(result.newChunks), [CHUNK_A]);
});

test("inline chunks must lie inside the manifest's inline section", async () => {
  const inlineOk = manifest({ chunks: { [CHUNK_A]: [OWN_KEY, 16, 1024, 1234] } });
  const ok = await validateManifest(inlineOk, context());
  assert.equal(ok.packSizes.get(OWN_KEY), 4096);
  const inlineBad = manifest({ chunks: { [CHUNK_A]: [OWN_KEY, 16, 2000, 1234] } });
  await assert.rejects(validateManifest(inlineBad, context()), /outside the manifest's inline section/);
});

test("a snapshot repeats known chunks without redeclaring them", async () => {
  const snapshot = manifest({
    full: true,
    upserts: [{ p: "kept.bin", k: "f", m: 0o644, s: 10, c: [[KNOWN, 10]] }],
    deletes: [],
    chunks: { [KNOWN]: [`${PACK_PREFIX}000099`, 0, 1, 10] }, // the host's own record wins; this pack need not exist
  });
  const result = await validateManifest(snapshot, context());
  assert.deepEqual(result.newChunks, {});
});

/** The 18 rejection cases of the prototype's T14, kept as the shared vector set for the Rust side. */
const REJECTIONS: Array<{ name: string; manifest: Manifest; reason: RegExp; ctx?: Partial<ValidationContext> }> = [
  { name: "wrong protocol version", manifest: manifest({ v: 2 }), reason: /identity mismatch/ },
  { name: "wrong volume", manifest: manifest({ volume: "other" }), reason: /identity mismatch/ },
  { name: "wrong attachment", manifest: manifest({ attachment: "other" }), reason: /identity mismatch/ },
  { name: "seq skips ahead", manifest: manifest({ seq: 3, base: 2 }), reason: /sequence gap/ },
  { name: "base does not match head", manifest: manifest({ seq: 1, base: 5 }), reason: /sequence gap/ },
  { name: "path traversal", manifest: manifest({ upserts: [{ p: "../etc/passwd", k: "f", m: 0o644, s: 0, c: [] }] }), reason: /invalid path/ },
  { name: "absolute path", manifest: manifest({ upserts: [{ p: "/etc/passwd", k: "f", m: 0o644, s: 0, c: [] }] }), reason: /invalid path/ },
  { name: "helper state path", manifest: manifest({ upserts: [{ p: ".sourceweft/identity", k: "f", m: 0o644, s: 0, c: [] }] }), reason: /invalid path/ },
  { name: "control character in path", manifest: manifest({ upserts: [{ p: "a\u0001b", k: "d", m: 0o755 }] }), reason: /invalid path/ },
  { name: "unknown kind", manifest: manifest({ upserts: [{ p: "x", k: "s" as never, m: 0o644 }] }), reason: /invalid kind/ },
  { name: "mode out of range", manifest: manifest({ upserts: [{ p: "x", k: "d", m: 0o10000 }] }), reason: /invalid mode/ },
  { name: "symlink target with NUL", manifest: manifest({ upserts: [{ p: "l", k: "l", m: 0o777, l: "a\u0000b" }] }), reason: /invalid symlink target/ },
  { name: "negative size", manifest: manifest({ upserts: [{ p: "x", k: "f", m: 0o644, s: -1, c: [] }] }), reason: /invalid size/ },
  { name: "unknown chunk referenced", manifest: manifest({ upserts: [{ p: "x", k: "f", m: 0o644, s: 5, c: [[CHUNK_B, 5]] }] }), reason: /unknown chunk/ },
  { name: "chunk lengths do not add up", manifest: manifest({ upserts: [{ p: "x", k: "f", m: 0o644, s: 9, c: [[CHUNK_A, 1234]] }] }), reason: /do not add up/ },
  { name: "chunk in another attachment's pack", manifest: manifest({ chunks: { [CHUNK_A]: ["att/other/p/000000", 0, 812, 1234] } }), reason: /outside this attachment's packs/ },
  { name: "pack missing from the bucket", manifest: manifest({ chunks: { [CHUNK_A]: [`${PACK_PREFIX}000001`, 0, 812, 1234] } }), reason: /not in the bucket/ },
  { name: "chunk past the end of its pack", manifest: manifest({ chunks: { [CHUNK_A]: [`${PACK_PREFIX}000000`, 2000, 812, 1234] } }), reason: /past the end of its pack/ },
  { name: "malformed chunk id", manifest: manifest({ chunks: { zz: [`${PACK_PREFIX}000000`, 0, 812, 1234] }, upserts: [] }), reason: /malformed chunk record/ },
  { name: "chunk raw length over the limit", manifest: manifest({ chunks: { [CHUNK_A]: [`${PACK_PREFIX}000000`, 0, 812, 65 * 1024 * 1024] }, upserts: [] }), reason: /chunk bounds/ },
  { name: "invalid delete path", manifest: manifest({ deletes: ["a/../b"] }), reason: /invalid delete path/ },
  { name: "too many entries", manifest: manifest({ deletes: Array.from({ length: 200_001 }, (_, i) => `d/${i}`) }), reason: /too many entries/ },
];

test("every malicious or malformed manifest is rejected with the expected reason", async () => {
  for (const { name, manifest: m, reason, ctx } of REJECTIONS) {
    await assert.rejects(validateManifest(m, context(ctx)), (error: unknown) => error instanceof ManifestRejected && reason.test(error.message), name);
  }
});

test("rejection vectors are written for the helper's test-suite", () => {
  const dir = join(dirname(new URL(import.meta.url).pathname), "..", "vectors");
  mkdirSync(dir, { recursive: true });
  const vectors = REJECTIONS.filter((r) => r.name !== "too many entries").map(({ name, manifest: m, reason }) => ({ name, manifest: m, reason: reason.source }));
  const accepted = { context: { volume: VOLUME, attachment: ATTACHMENT, head: 0, packPrefix: PACK_PREFIX, ownKey: OWN_KEY, knownChunks: [KNOWN], packs: { [`${PACK_PREFIX}000000`]: 2048 } }, manifest: manifest() };
  writeFileSync(join(dir, "manifests.json"), `${JSON.stringify({ accepted, rejected: vectors }, null, 2)}\n`);
  assert.ok(vectors.length >= 18);
});

export type { ChunkLocation };
