import assert from "node:assert/strict";
import { test } from "node:test";
import { validateManifest } from "../src/protocol/validate";
import type { Manifest } from "../src/protocol/types";
import { isValidVolumePath } from "../src/protocol/paths";
import {
  parseManifestObject,
  encodeManifestObject,
} from "../src/protocol/manifest";
import { zstdCompressSync } from "node:zlib";
const chunk = "a".repeat(64);
const ctx = {
  volumeId: "v",
  attachmentId: "a",
  head: 0,
  bootId: "boot",
  slotsUntilPack: 2,
  slotsUntilSeq: 64,
  packPrefix: "att/a/p/",
  ownKey: "att/a/m/0/1",
  rawLength: 100,
  inlineRange: [16, 16] as [number, number],
  chunkKnown: async () => true,
  chunkLength: async () => 5,
  packSize: async () => 20,
};
const base: Manifest = {
  v: 1,
  volume: "v",
  attachment: "a",
  boot_id: "boot",
  seq: 1,
  base: 0,
  upserts: [],
  chunks: {},
};

test("mtime preserves the helper's signed 64-bit nanosecond range", async () => {
  for (const t of [
    "-1",
    "-123456789123456789",
    "-9223372036854775808",
    "9223372036854775807",
  ])
    await validateManifest(
      { ...base, upserts: [{ p: "x", k: "d", m: 493, t }] },
      ctx,
    );
  for (const t of ["-9223372036854775809", "9223372036854775808"])
    await assert.rejects(
      validateManifest(
        { ...base, upserts: [{ p: "x", k: "d", m: 493, t }] },
        ctx,
      ),
      /database range/,
    );
  for (const t of ["--1", "-", "+1", "1.1"])
    await assert.rejects(
      validateManifest(
        { ...base, upserts: [{ p: "x", k: "d", m: 493, t }] },
        ctx,
      ),
      /invalid mtime/,
    );
});

test("non-scalar Unicode cannot alias a different stored filename or symlink target", async () => {
  assert.deepEqual(
    Buffer.from("x\ud800", "utf8"),
    Buffer.from("x\ufffd", "utf8"),
    "the storage encoder would otherwise collapse these names",
  );
  for (const invalid of ["x\ud800", "x\udc00", "x\ud800y", "x\udc00\ud800"]) {
    assert.equal(isValidVolumePath(invalid), false);
    await assert.rejects(
      validateManifest(
        { ...base, upserts: [{ p: invalid, k: "d", m: 493 }] },
        ctx,
      ),
      /invalid path/,
    );
    await assert.rejects(
      validateManifest({ ...base, deletes: [invalid] }, ctx),
      /invalid.*path/,
    );
    await assert.rejects(
      validateManifest(
        { ...base, upserts: [{ p: "link", k: "l", m: 511, l: invalid }] },
        ctx,
      ),
      /symlink target/,
    );
  }
  for (const valid of ["x\ufffd", "x😀", "中文", "e\u0301", "é"])
    assert.equal(isValidVolumePath(valid), true);
});

test("invalid UTF-8 in compressed JSON is rejected before replacement decoding can change a path", () => {
  const header = Buffer.alloc(16);
  header.write("SWVOLM1\n");
  const raw = Buffer.concat([
    Buffer.from('{"v":1,"upserts":[{"p":"x'),
    Buffer.from([0xff]),
    Buffer.from('","k":"d","m":493}]}'),
  ]);
  assert.throws(
    () => parseManifestObject(Buffer.concat([header, zstdCompressSync(raw)])),
    /unparseable manifest/,
  );
});

test("host path components fit the existing Rust restore contract", () => {
  assert.equal(isValidVolumePath("a".repeat(256)), false);
  assert.equal(isValidVolumePath("😀".repeat(64)), false);
  assert.equal(isValidVolumePath("a".repeat(255)), true);
});
test("host entry shapes fit the existing Rust restore contract", async () => {
  for (const target of ["", "a".repeat(4096), "😀".repeat(1024)])
    await assert.rejects(
      validateManifest(
        { ...base, upserts: [{ p: "link", k: "l", m: 511, l: target }] },
        ctx,
      ),
      /symlink target/,
    );
  await validateManifest(
    { ...base, upserts: [{ p: "link", k: "l", m: 511, l: "a".repeat(4095) }] },
    ctx,
  );
  for (const entry of [
    { p: "x", k: "d", m: 493, s: 1 },
    { p: "x", k: "d", m: 493, c: [[chunk, 5]] },
    { p: "x", k: "d", m: 493, l: "target" },
    { p: "x", k: "l", m: 511, l: "target", s: 1 },
    { p: "x", k: "l", m: 511, l: "target", c: [[chunk, 5]] },
    { p: "x", k: "f", m: 420, s: 0, c: [], l: "target" },
  ])
    await assert.rejects(
      validateManifest({ ...base, upserts: [entry] } as Manifest, ctx),
      /entry shape|symlink target/,
    );
});
test("host chunk bounds fit the existing Rust restore contract", async () => {
  for (const [compressed, raw] of [
    [1, 4 * 1024 * 1024 + 1],
    [8 * 1024 * 1024 + 1, 1],
    [0, 1],
    [1, 0],
  ]) {
    await assert.rejects(
      validateManifest(
        {
          ...base,
          chunks: { [chunk]: ["att/a/p/000000", 0, compressed!, raw!] },
        },
        { ...ctx, packSize: async () => 100 * 1024 * 1024 },
      ),
      /chunk bounds/,
    );
  }
  await assert.rejects(
    validateManifest(
      { ...base, upserts: [{ p: "x", k: "f", m: 420, s: 0, c: [[chunk, 0]] }] },
      { ...ctx, chunkLength: async () => 0 },
    ),
    /unknown chunk/,
  );
});

test("inline object bytes stay within the existing helper pack limit", () => {
  assert.equal(
    parseManifestObject(
      encodeManifestObject(base, Buffer.alloc(4 * 1024 * 1024)),
    ).inlineRange[1],
    16 + 4 * 1024 * 1024,
  );
  assert.throws(
    () =>
      parseManifestObject(
        encodeManifestObject(base, Buffer.alloc(4 * 1024 * 1024 + 1)),
      ),
    /inline section.*limit/,
  );
});
test("strict envelope, boot, slots and numeric bounds reject malformed manifests", async () => {
  for (const [patch, reason] of [
    [{ boot_id: "old" }, /boot identity/],
    [{ boot_id: undefined }, /boot identity/],
    [{ full: "false" }, /full flag/],
    [{ upserts: {} }, /upserts array/],
    [{ chunks: [] }, /chunks object/],
    [
      {
        upserts: [
          {
            p: "x",
            k: "f",
            m: 420,
            s: 0,
            c: [
              [chunk, -5],
              [chunk, 5],
            ],
          },
        ],
      },
      /unknown chunk/,
    ],
    [
      { upserts: [{ p: "x", k: "f", m: 420, s: 4, c: [[chunk, 4]] }] },
      /recorded chunk/,
    ],
    [
      { upserts: [{ p: "x", k: "d", m: 493, t: "9999999999999999999" }] },
      /database range/,
    ],
    [
      {
        upserts: [
          { p: "x", k: "d", m: 493 },
          { p: "x", k: "d", m: 493 },
        ],
      },
      /duplicate/,
    ],
    [
      {
        upserts: [
          { p: "x", k: "f", m: 420, s: 0, c: [] },
          { p: "x/y", k: "d", m: 493 },
        ],
      },
      /parent/,
    ],
    [{ chunks: { [chunk]: ["att/a/p/000002", 0, 5, 5] } }, /no issued slot/],
    [
      {
        chunks: { [chunk]: ["att/a/p/000000", Number.MAX_SAFE_INTEGER, 5, 5] },
      },
      /chunk bounds/,
    ],
  ] as Array<[unknown, RegExp]>)
    await assert.rejects(
      validateManifest({ ...base, ...(patch as object) }, ctx),
      reason,
    );
  await assert.rejects(
    validateManifest(base, { ...ctx, slotsUntilSeq: 0 }),
    /no issued slot/,
  );
});
test("valid existing chunk extent matches its authoritative length", async () => {
  await validateManifest(
    { ...base, upserts: [{ p: "x", k: "f", m: 420, s: 5, c: [[chunk, 5]] }] },
    ctx,
  );
});

test("declaring a known chunk again cannot override its authoritative length", async () => {
  await assert.rejects(
    validateManifest(
      {
        ...base,
        chunks: { [chunk]: ["att/a/p/000000", 0, 4, 4] },
        upserts: [{ p: "x", k: "f", m: 420, s: 4, c: [[chunk, 4]] }],
      },
      ctx,
    ),
    /recorded chunk/,
  );
});
