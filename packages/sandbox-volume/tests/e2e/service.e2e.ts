import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { encodeManifestObject, type Manifest, type SlotSet } from "../../src/protocol/index";
import { cleanupVolume, createE2EContext, e2eEnabled, putWriteOnce, type E2EContext } from "./env";

/**
 * Host-side e2e: a simulated helper commits manifests through real write-once slots in the real
 * bucket; the service applies them into the real Postgres. Covers the WAL chain, write-once
 * enforcement, snapshots, rejection + rebase, point-in-time rollback and pack repair.
 */
let ctx: E2EContext;
let volumeId: string;

before(async () => {
  if (!e2eEnabled) return;
  ctx = await createE2EContext();
});
after(async () => {
  if (!ctx) return;
  if (volumeId) await cleanupVolume(ctx, volumeId);
  await ctx.store.deletePrefix(ctx.keyPrefix);
  await ctx.close();
});

function blake3ish(content: Buffer): string {
  // The host never recomputes chunk hashes (it trusts the helper's ids and verifies on restore), so any 64-hex id works here.
  return createHash("sha256").update(content).digest("hex");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return (await response.json()) as T;
}

test("write-once slots, WAL application, snapshot, rejection, rebase, rollback and repair", { skip: !e2eEnabled }, async () => {
  const { service, store } = ctx;
  const volume = await service.getOrCreateVolume(ctx.scope);
  volumeId = volume.id;
  const attachment = await service.attach(volume.id, "sandbox-e2e");
  const files = await service.publishAttachFiles(attachment);
  assert.equal(files.planSeq, 0);
  const slots = await fetchJson<SlotSet>(files.slotsUrl);
  assert.equal(slots.attachment, attachment.id);

  // seq 1: a pack with two chunks, three entries, one inline-free manifest.
  const chunkA = Buffer.from("hello world, chunk A");
  const chunkB = Buffer.from("chunk B is a bit longer than chunk A");
  const packedA = zstdCompressSync(chunkA);
  const packedB = zstdCompressSync(chunkB);
  const pack = Buffer.concat([packedA, packedB]);
  const packKey = `${slots.pack_prefix}000000`;
  assert.equal(await putWriteOnce(slots.packs["0"]!, pack), 200);
  assert.equal(await putWriteOnce(slots.packs["0"]!, pack), 412, "a second write to the same slot must be refused");
  assert.equal(await putWriteOnce(slots.packs["1"]!, pack, false), 403, "the conditional header is part of the signature");
  const idA = blake3ish(chunkA);
  const idB = blake3ish(chunkB);
  const m1: Manifest = {
    v: 1, volume: volume.id, attachment: attachment.id, seq: 1, base: 0, trigger: "flush",
    upserts: [
      { p: "src", k: "d", m: 0o755 },
      { p: "src/a.txt", k: "f", m: 0o644, t: "1700000000000000000", s: chunkA.length, c: [[idA, chunkA.length]] },
      { p: "src/b.txt", k: "f", m: 0o600, t: "1700000000000000001", s: chunkB.length, c: [[idB, chunkB.length]] },
      { p: "link", k: "l", m: 0o777, l: "src/a.txt" },
    ],
    deletes: [],
    chunks: { [idA]: [packKey, 0, packedA.length, chunkA.length], [idB]: [packKey, packedA.length, packedB.length, chunkB.length] },
    packs: [[packKey, pack.length]],
  };
  assert.equal(await putWriteOnce(slots.manifests["1"]!, encodeManifestObject(m1)), 200);
  let wal = await service.applyWal(attachment.id);
  assert.equal(wal.applied, 1);
  assert.equal(await service.repo.head(volume.id), 1);
  let entries = await service.repo.entries(volume.id);
  assert.deepEqual(entries.map((e) => e.path), ["link", "src", "src/a.txt", "src/b.txt"]);

  // seq 2: inline chunk inside the manifest object, delete b, overwrite a.
  const chunkC = Buffer.from("inline content for a.txt");
  const packedC = zstdCompressSync(chunkC);
  const idC = blake3ish(chunkC);
  const ownKey = `${slots.manifest_prefix}2`;
  const m2: Manifest = {
    v: 1, volume: volume.id, attachment: attachment.id, seq: 2, base: 1, trigger: "debounce",
    upserts: [{ p: "src/a.txt", k: "f", m: 0o644, t: "1700000000000000002", s: chunkC.length, c: [[idC, chunkC.length]] }],
    deletes: ["src/b.txt"],
    chunks: { [idC]: [ownKey, 16, packedC.length, chunkC.length] },
  };
  assert.equal(await putWriteOnce(slots.manifests["2"]!, encodeManifestObject(m2, packedC)), 200);
  wal = await service.applyWal(attachment.id);
  assert.equal(wal.applied, 1);
  entries = await service.repo.entries(volume.id);
  assert.deepEqual(entries.map((e) => e.path), ["link", "src", "src/a.txt"]);
  assert.deepEqual(entries.find((e) => e.path === "src/a.txt")!.chunks, [[idC, chunkC.length]]);

  // The plan now references the pack and the manifest object (inline) with GET urls.
  const plan = await service.plan(attachment);
  assert.equal(plan.seq, 2);
  assert.deepEqual(Object.keys(plan.packs), [ownKey], "only packs that still hold live chunks are in the plan");
  assert.equal(plan.chunks[idC]![0], ownKey);
  const planAsSeen = await fetch(plan.packs[ownKey]!, { headers: { Range: "bytes=16-" + (16 + packedC.length - 1) } });
  assert.equal(planAsSeen.status, 206);

  // seq 3: a hostile manifest (chunk in another attachment's pack) is rejected and the chain stops there.
  const m3: Manifest = { ...m1, seq: 3, base: 2, upserts: [{ p: "evil", k: "f", m: 0o644, s: 5, c: [[idB, 5]] }], chunks: { [idB]: ["att/other/p/000000", 0, 5, 5] }, deletes: [] };
  assert.equal(await putWriteOnce(slots.manifests["3"]!, encodeManifestObject(m3)), 200);
  wal = await service.applyWal(attachment.id);
  assert.equal(wal.applied, 0);
  assert.match(wal.rejected ?? "", /outside this attachment's packs/);
  assert.equal(await service.repo.head(volume.id), 2);
  assert.equal(await service.repo.rejectCount(volume.id), 1);

  // Rebase: new epoch, new slots, a full snapshot based on head is accepted.
  const rebase = await service.beginRebase(attachment.id);
  assert.equal(rebase.attachment.epoch, 1);
  const slots2 = await fetchJson<SlotSet>(rebase.slotsUrl);
  assert.equal(slots2.manifest_prefix, `att/${attachment.id}/m/1/`);
  const snapshot: Manifest = {
    v: 1, volume: volume.id, attachment: attachment.id, seq: 3, base: 2, trigger: "rebase", full: true,
    upserts: [
      { p: "src", k: "d", m: 0o755 },
      { p: "src/a.txt", k: "f", m: 0o644, t: "1700000000000000002", s: chunkC.length, c: [[idC, chunkC.length]] },
      { p: "new.txt", k: "f", m: 0o644, t: "1700000000000000003", s: chunkA.length, c: [[idA, chunkA.length]] },
    ],
    deletes: [],
    chunks: { [idC]: [ownKey, 16, packedC.length, chunkC.length], [idA]: [packKey, 0, packedA.length, chunkA.length] },
  };
  assert.equal(await putWriteOnce(slots2.manifests["3"]!, encodeManifestObject(snapshot)), 200);
  wal = await service.applyWal(attachment.id);
  assert.equal(wal.applied, 1);
  entries = await service.repo.entries(volume.id);
  assert.deepEqual(entries.map((e) => e.path), ["new.txt", "src", "src/a.txt"], "the snapshot drops `link`, which it did not list");

  // History: the tree at seq 1 still has b.txt and link; rollback to it is a new commit.
  const at1 = await service.repo.entriesAt(volume.id, 1);
  assert.deepEqual(at1.map((e) => e.path), ["link", "src", "src/a.txt", "src/b.txt"]);
  assert.deepEqual(at1.find((e) => e.path === "src/a.txt")!.chunks, [[idA, chunkA.length]]);
  const newHead = await service.rollback(volume.id, 1);
  assert.equal(newHead, 4);
  entries = await service.repo.entries(volume.id);
  assert.deepEqual(entries.map((e) => e.path), ["link", "src", "src/a.txt", "src/b.txt"]);

  // Repair: the pack is copied server-side and every chunk repointed; the new key is readable.
  const repaired = await service.repairPack(volume.id, packKey);
  assert.notEqual(repaired, packKey);
  const locations = await service.chunkLocations(volume.id, [idA, idB]);
  assert.equal(locations[idA]![0], repaired);
  assert.equal(await store.size(`${service.volumePrefix(volume.id)}${repaired}`), pack.length);

  // A second attachment applies the first one's leftovers before starting and starts at the new head.
  const attachment2 = await service.attach(volume.id, "sandbox-e2e-2");
  assert.equal(attachment2.baseSeq, 4);
  assert.equal((await service.repo.getAttachment(attachment.id))!.status, "superseded");
});
