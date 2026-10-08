import assert from "node:assert/strict";
import { test } from "node:test";
import { validateManifest } from "../src/protocol/validate";
import type { Manifest } from "../src/protocol/types";
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
