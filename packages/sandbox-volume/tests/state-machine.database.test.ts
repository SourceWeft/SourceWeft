import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  writeFileSync,
  appendFileSync,
  fsyncSync,
  closeSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { VolumeService } from "../src/service/volume-service";
import { VolumeConflict, type AttachmentRow } from "../src/service/repository";
import { encodeManifestObject } from "../src/protocol/manifest";
import type {
  Manifest,
  ManifestEntry,
  ChunkLocation,
} from "../src/protocol/types";
import type { ObjectStore } from "../src/store/object-store";

const url = process.env.SANDBOX_VOLUME_TEST_DATABASE_URL;
const schema = `model_${randomUUID().replaceAll("-", "")}`;
let admin: Pool, pool: Pool;
let retainSchema = process.env.SANDBOX_VOLUME_MODEL_PRESERVE === "1";
before(async () => {
  if (!url) return;
  admin = new Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
    max: 12,
  });
  await pool.query(
    "create table workspaces(id text primary key); create table threads(id text primary key,workspace_id text not null,team_id text not null,unique(id,workspace_id,team_id));",
  );
  const migrations = new URL("../../db/drizzle/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => /^\d+_sandbox_volumes?.*\.sql$/.test(name))
    .sort())
    await pool.query(
      readFileSync(new URL(name, migrations), "utf8").replaceAll(
        '"public".',
        `"${schema}".`,
      ),
    );
});
after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    if (admin) {
      try {
        if (!retainSchema) await admin.query(`drop schema ${schema} cascade`);
      } finally {
        await admin.end();
      }
    }
  }
});

function durableWrite(path: string, value: Uint8Array | string) {
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function durableAppend(path: string, value: unknown) {
  const fd = openSync(path, "a", 0o600);
  try {
    appendFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
// Explicit local fixture object storage, mirrored to host disk so a PostgreSQL
// crash cannot destroy the independent oracle/evidence. This does not test S3.
class FixtureObjects extends Map<string, Uint8Array> {
  constructor(private readonly directory: string) {
    super();
  }
  override set(key: string, value: Uint8Array) {
    durableWrite(
      join(this.directory, createHash("sha256").update(key).digest("hex")),
      value,
    );
    return super.set(key, value);
  }
  override delete(key: string) {
    rmSync(
      join(this.directory, createHash("sha256").update(key).digest("hex")),
      { force: true },
    );
    return super.delete(key);
  }
}

// Independent hierarchical filesystem oracle. Tree deletion removes one child
// node; it never reuses SQL range predicates, repository helpers or flat prefix deletion.
type Node =
  | { kind: "directory"; children: Map<string, Node> }
  | { kind: "file"; text: string; mode: number; time: string }
  | { kind: "link"; target: string; time: string };
type Tree = Extract<Node, { kind: "directory" }>;
const directory = (): Tree => ({ kind: "directory", children: new Map() });
const copy = (tree: Tree): Tree => structuredClone(tree);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function entries(tree: Tree): ManifestEntry[] {
  const result: ManifestEntry[] = [];
  const visit = (node: Node, path: string) => {
    if (node.kind === "directory") {
      if (path) result.push({ p: path, k: "d", m: 0o755, t: "0" });
      for (const [name, child] of node.children)
        visit(child, path ? `${path}/${name}` : name);
    } else if (node.kind === "link")
      result.push({ p: path, k: "l", m: 0o777, t: node.time, l: node.target });
    else
      result.push({
        p: path,
        k: "f",
        m: node.mode,
        t: node.time,
        s: Buffer.byteLength(node.text),
        c: [[hash(node.text), Buffer.byteLength(node.text)]],
      });
  };
  visit(tree, "");
  return result.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}
function content(tree: Tree, path: string): string {
  let node: Node = tree;
  for (const name of path.split("/")) {
    assert.equal(node.kind, "directory");
    node = (node as Tree).children.get(name)!;
  }
  assert.equal(node.kind, "file");
  return (node as Extract<Node, { kind: "file" }>).text;
}
function random(seed: number) {
  let state = seed >>> 0 || 0x6d2b79f5;
  return (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
}
const seedInput = process.env.SANDBOX_VOLUME_RANDOM_SEED;
const seeds =
  seedInput === undefined
    ? [0x228, 0xa11ce, 0xc0ffee, 0xdeadbeef]
    : [Number(seedInput)];
const steps = Number(process.env.SANDBOX_VOLUME_RANDOM_STEPS ?? 140);
assert.ok(
  seeds.every(
    (seed) => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff,
  ),
);
assert.ok(Number.isSafeInteger(steps) && steps >= 10 && steps <= 2000);

for (const seed of seeds)
  test(
    `seed=${seed}: model-checked PostgreSQL histories and multi-host lifecycle races`,
    { skip: !url, timeout: Math.min(900_000, 180_000 + steps * 1000) },
    async (t) => {
      const rng = random(seed),
        scopeId = randomUUID();
      await pool.query("insert into workspaces values($1);", [scopeId]);
      await pool.query("insert into threads values($1,$1,$1);", [scopeId]);
      const evidenceDirectory = mkdtempSync(
        join(tmpdir(), `swvol-model-${seed}-`),
      );
      const objectDirectory = join(evidenceDirectory, "objects");
      mkdirSync(objectDirectory, { mode: 0o700 });
      const objects = new FixtureObjects(objectDirectory),
        deleted: string[] = [];
      const ledgerPath = join(evidenceDirectory, "confirmed.jsonl");
      durableWrite(ledgerPath, "");
      const store: ObjectStore = {
        presignWriteOnce: async (key) => key,
        presignGet: async (key) => key,
        get: async (key) => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return objects.get(key) ?? null;
        },
        put: async (key, bytes) => {
          objects.set(key, new Uint8Array(bytes));
        },
        size: async (key) => objects.get(key)?.byteLength ?? null,
        copy: async (from, to) => {
          const bytes = objects.get(from);
          assert.ok(bytes);
          objects.set(to, bytes.slice());
        },
        deleteObject: async (key) => {
          deleted.push(key);
          objects.delete(key);
        },
        deletePrefix: async () => {
          throw new Error("model test forbids prefix deletion");
        },
      };
      const hosts = Array.from(
        { length: 4 },
        () =>
          new VolumeService({
            db: drizzle(pool),
            store,
            keyPrefix: `seed-${seed}/`,
            gcGraceMs: 0,
          }),
      );
      const service = hosts[0]!,
        volume = await service.getOrCreateVolume({
          teamId: scopeId,
          workspaceId: scopeId,
          threadId: scopeId,
        });
      durableWrite(
        join(evidenceDirectory, "meta.json"),
        JSON.stringify({
          version: 1,
          seed,
          steps,
          schema,
          volumeId: volume.id,
          keyPrefix: service.volumePrefix(volume.id),
        }) + "\n",
      );
      t.diagnostic(`independent ledger=${evidenceDirectory} schema=${schema}`);
      const log: Array<Record<string, unknown>> = [];
      const snapshots: Tree[] = [directory()];
      let tree = directory(),
        head = 0,
        actor!: AttachmentRow,
        counter = 0;
      const origins = new Map<string, ChunkLocation>();
      const committedChunks = new Set<string>();
      let invalidAttempts = 0;
      const races = {
        commitRebase: 0,
        commitRollbackGc: 0,
        commitDrainGc: 0,
        commitRecoveryGc: 0,
      };
      const expectedFence = (result: PromiseSettledResult<unknown>) => {
        if (result.status === "rejected")
          assert.ok(
            result.reason instanceof VolumeConflict ||
              /attachment .* is not active/.test(String(result.reason)),
            `unexpected race failure: ${String(result.reason)}`,
          );
      };
      const acknowledged: Array<{ seq: number; tree: Tree }> = [];
      const acknowledge = () => {
        acknowledged.push({ seq: head, tree: copy(tree) });
        durableAppend(ledgerPath, {
          seq: head,
          entries: entries(tree),
          contents: Object.fromEntries(
            entries(tree)
              .filter((entry) => entry.k === "f")
              .map((entry) => [entry.p, content(tree, entry.p)]),
          ),
        });
      };
      const newActor = async () => {
        actor = await service.attach(volume.id, `instance-${randomUUID()}`);
        await service.recordBootId(actor.id, "model-boot");
        await service.bindSupervisorIdentity(actor.id, randomUUID());
        await service.issueSlots(actor);
        actor = (await service.repo.getAttachment(actor.id))!;
        counter = 0;
      };
      await newActor();
      const advance = (next: Tree) => {
        tree = copy(next);
        snapshots.push(copy(next));
        head++;
        for (const entry of entries(next))
          for (const [id] of entry.c ?? []) committedChunks.add(id);
      };
      const normalize = (
        rows: Awaited<ReturnType<typeof service.repo.entries>>,
      ) =>
        rows
          .map((row) => ({
            p: row.path,
            k: row.kind,
            m: row.mode,
            t: row.mtimeNs.toString(),
            ...(row.kind === "f"
              ? { s: row.sizeBytes, c: row.chunks }
              : row.kind === "l"
                ? { l: row.linkTarget }
                : {}),
          }))
          .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
      const verify = async (all = false) => {
        assert.equal(await service.repo.head(volume.id), head);
        assert.deepEqual(
          normalize(await service.repo.entries(volume.id)),
          entries(tree),
        );
        const versions = all
          ? snapshots.map((_, i) => i)
          : [...new Set([0, head, rng(head + 1)])];
        const histories = new Map<number, ReturnType<typeof normalize>>();
        // Keep all history assertions; batch only independent immutable reads.
        for (let start = 0; start < versions.length; start += 8)
          await Promise.all(
            versions.slice(start, start + 8).map(async (seq) => {
              const actual = normalize(
                await service.repo.entriesAt(volume.id, seq),
              );
              assert.deepEqual(
                actual,
                entries(snapshots[seq]!),
                `historical tree seq=${seq}`,
              );
              histories.set(seq, actual);
            }),
          );
        const plan = await service.repo.planSnapshot(volume.id);
        assert.equal(plan.seq, head);
        for (const entry of plan.entries.filter((entry) => entry.k === "f")) {
          const chunks = entry.c.map(([id]) => {
            const [key, off, length] = plan.chunks[id]!;
            const bytes = objects.get(
              `${service.volumePrefix(volume.id)}${key}`,
            );
            assert.ok(bytes, `GC deleted referenced pack ${key}`);
            return zstdDecompressSync(bytes.subarray(off, off + length));
          });
          assert.equal(
            Buffer.concat(chunks).toString(),
            content(tree, entry.p),
          );
        }
        return histories;
      };
      const mutate = (serial: number): Tree => {
        const next = copy(tree),
          names = ["A", "a", "Á", "A0", "src", "space dir"];
        const name = names[rng(names.length)]!,
          other = names[rng(names.length)]!;
        switch (rng(6)) {
          case 0:
            next.children.delete(name);
            break;
          case 1:
            next.children.set(name, {
              kind: "file",
              text: `top-${seed}-${serial}`,
              mode: 0o600,
              time: String(serial * 1000000),
            });
            break;
          case 2:
            next.children.set(name, {
              kind: "link",
              target: `../${other}/target`,
              time: String(serial * 1000000),
            });
            break;
          case 3: {
            const value = next.children.get(name);
            if (value && name !== other) {
              next.children.delete(name);
              next.children.set(other, value);
            }
            break;
          }
          default: {
            let node = next.children.get(name);
            if (node?.kind !== "directory") {
              node = directory();
              next.children.set(name, node);
            }
            node.children.set(`file${rng(6)}`, {
              kind: "file",
              text: `payload-${seed}-${serial}-${rng(10000)}`,
              mode: rng(2) ? 0o644 : 0o600,
              time: String(serial * 1000000),
            });
          }
        }
        return next;
      };
      const upload = async (next: Tree, full: boolean): Promise<Manifest> => {
        actor = (await service.repo.getAttachment(actor.id))!;
        const before = new Map(entries(tree).map((entry) => [entry.p, entry]));
        const after = entries(next),
          afterPaths = new Set(after.map((entry) => entry.p));
        const upserts = full
          ? after
          : after.filter(
              (entry) =>
                JSON.stringify(entry) !== JSON.stringify(before.get(entry.p)),
            );
        const removed = [...before.keys()].filter(
          (path) => !afterPaths.has(path),
        );
        const removes = new Set(removed);
        const deletes = removed.filter((path) => {
          let p = path;
          while (p.includes("/")) {
            p = p.slice(0, p.lastIndexOf("/"));
            if (removes.has(p)) return false;
          }
          return true;
        });
        const chunks: Record<string, ChunkLocation> = {};
        for (const entry of upserts.filter((entry) => entry.k === "f")) {
          const id = entry.c![0]![0];
          if (!origins.has(id)) {
            if (counter >= actor.slotsUntilPack) {
              await service.issueSlots(actor);
              actor = (await service.repo.getAttachment(actor.id))!;
            }
            const packed = zstdCompressSync(
                Buffer.from(content(next, entry.p)),
              ),
              key = `${service.packPrefix(actor)}${String(counter++).padStart(6, "0")}`;
            origins.set(id, [key, 0, packed.length, entry.s!]);
            objects.set(`${service.volumePrefix(volume.id)}${key}`, packed);
          }
          if (full || !committedChunks.has(id)) chunks[id] = origins.get(id)!;
        }
        // A real capture may upload chunks that an unstable file never references.
        // Register such immutable orphan packs so GC is exercised, not only its pins.
        if (rng(5) === 0) {
          if (counter >= actor.slotsUntilPack) {
            await service.issueSlots(actor);
            actor = (await service.repo.getAttachment(actor.id))!;
          }
          const text = `orphan-${seed}-${actor.id}-${counter}`,
            id = hash(text),
            packed = zstdCompressSync(Buffer.from(text)),
            key = `${service.packPrefix(actor)}${String(counter++).padStart(6, "0")}`;
          objects.set(`${service.volumePrefix(volume.id)}${key}`, packed);
          chunks[id] = [key, 0, packed.length, Buffer.byteLength(text)];
        }
        if (head + 1 > actor.slotsUntilSeq) {
          await service.issueSlots(actor);
          actor = (await service.repo.getAttachment(actor.id))!;
        }
        const manifest: Manifest = {
          v: 1,
          volume: volume.id,
          attachment: actor.id,
          boot_id: "model-boot",
          seq: head + 1,
          base: head,
          full,
          upserts,
          deletes: full ? [] : deletes,
          chunks,
        };
        const key = `${service.volumePrefix(volume.id)}${service.manifestPrefix(actor)}${manifest.seq}`;
        assert.equal(
          objects.has(key),
          false,
          "test must honor immutable manifest objects",
        );
        objects.set(key, encodeManifestObject(manifest));
        return manifest;
      };
      try {
        for (let serial = 1; serial <= steps; serial++) {
          t.signal.throwIfAborted();
          const operation = rng(11);
          log.push({
            serial,
            operation,
            head,
            actor: actor.id,
            epoch: actor.epoch,
          });
          if (operation <= 5) {
            const next = mutate(serial);
            await upload(next, rng(5) === 0);
            const count = 1 + rng(4);
            const results = await Promise.all(
              hosts.slice(0, count).map((host) => host.applyWal(actor.id)),
            );
            assert.equal(
              results.reduce((sum, result) => sum + result.applied, 0),
              1,
            );
            assert.ok(results.every((result) => result.rejected === null));
            advance(next);
            assert.equal(
              await service.confirmPersistence(actor.id, head),
              true,
            );
            acknowledge();
          } else if (operation === 6) {
            const next = mutate(serial),
              before = head;
            await upload(next, false);
            const results: PromiseSettledResult<unknown>[] =
              await Promise.allSettled([
                hosts[1]!.applyWal(actor.id),
                hosts[2]!.beginRebase(actor.id),
              ]);
            assert.equal(results[1]!.status, "fulfilled");
            expectedFence(results[0]!);
            races.commitRebase++;
            const observedHead = await service.repo.head(volume.id);
            assert.ok(observedHead === before || observedHead === before + 1);
            if (observedHead === before + 1) advance(next);
            actor = (await service.repo.getAttachment(actor.id))!;
          } else if (operation === 7) {
            const target = rng(head + 1),
              targetTree = copy(snapshots[target]!),
              priorActor = actor.id,
              before = head,
              next = mutate(serial);
            await upload(next, false);
            const [commit, rollback, gc] = await Promise.allSettled([
              hosts[1]!.applyWal(actor.id),
              hosts[2]!.rollback(volume.id, target),
              hosts[3]!.maintenance.collect(volume.id, { dryRun: false }),
            ]);
            expectedFence(commit);
            assert.equal(rollback.status, "fulfilled");
            assert.equal(gc.status, "fulfilled");
            if (rollback.status !== "fulfilled" || gc.status !== "fulfilled")
              throw new Error("rollback/GC did not complete");
            assert.equal(gc.value.failures.length, 0);
            races.commitRollbackGc++;
            const observedHead = await service.repo.head(volume.id);
            assert.ok(
              observedHead === before + 1 || observedHead === before + 2,
            );
            // Both legal serializations are modeled from the independent trees:
            // commit→rollback retains candidate as history; rollback→commit fences candidate.
            if (observedHead === before + 2) advance(next);
            advance(targetTree);
            assert.equal(rollback.value, head);
            assert.equal(
              await service.confirmPersistence(priorActor, head),
              false,
            );
            await newActor();
          } else if (operation === 8) {
            const identity = {
              sandboxId: actor.sandboxId!,
              bootId: actor.bootId!,
              supervisorNonce: actor.supervisorNonce!,
            };
            const before = head,
              next = mutate(serial);
            await upload(next, false);
            const [commit, drained, gc] = await Promise.allSettled([
              hosts[1]!.applyWal(actor.id),
              hosts[2]!.beginDrain(actor.id, {
                ...identity,
                operationId: `drain-${serial}`,
                reason: "seed-test",
              }),
              hosts[3]!.maintenance.collect(volume.id, { dryRun: false }),
            ]);
            expectedFence(commit);
            assert.equal(drained.status, "fulfilled");
            assert.equal(gc.status, "fulfilled");
            if (drained.status !== "fulfilled" || gc.status !== "fulfilled")
              throw new Error("drain/GC did not complete");
            assert.equal(gc.value.failures.length, 0);
            const drain = drained.value;
            races.commitDrainGc++;
            const observedHead = await service.repo.head(volume.id);
            assert.ok(observedHead === before || observedHead === before + 1);
            if (observedHead === before + 1) advance(next);
            // Only the drain capability can finish an upload fenced before its DB commit.
            const remaining = await service.applyWal(actor.id, {
              drainId: drain.drainId,
            });
            assert.equal(remaining.applied, head === before ? 1 : 0);
            if (head === before) advance(next);
            const proof = {
              ...identity,
              drainId: drain.drainId,
              stopped: true as const,
            };
            await service.recordSupervisorStop(actor.id, proof);
            assert.equal(
              (await service.maintenance.collect(volume.id, { dryRun: false }))
                .pinned,
              true,
            );
            assert.equal(
              await service.confirmPersistence(actor.id, head, {
                drainId: drain.drainId,
              }),
              true,
            );
            await service.finishDrain(actor.id, {
              drainId: drain.drainId,
              confirmedSeq: head,
              stopProof: proof,
            });
            await service.maintenance.collect(volume.id, { dryRun: false });
            await newActor();
          } else if (operation === 9) {
            const nonce = randomUUID();
            const before = head,
              next = mutate(serial);
            await upload(next, false);
            const [commit, recovery, gc] = await Promise.allSettled([
              hosts[1]!.applyWal(actor.id),
              hosts[2]!.recoverSupervisor(actor.id, {
                operationId: `recover-${serial}`,
                proof: {
                  sandboxId: actor.sandboxId!,
                  bootId: actor.bootId!,
                  previousSupervisorNonce: actor.supervisorNonce!,
                  supervisorNonce: nonce,
                  journalDigest: hash(`journal-${seed}-${serial}`),
                  allOldNamespacesExited: true,
                  launchGateClosed: true,
                },
              }),
              hosts[3]!.maintenance.collect(volume.id, { dryRun: false }),
            ]);
            expectedFence(commit);
            assert.equal(recovery.status, "fulfilled");
            assert.equal(gc.status, "fulfilled");
            if (recovery.status !== "fulfilled" || gc.status !== "fulfilled")
              throw new Error("recovery/GC did not complete");
            const recovered = recovery.value;
            assert.equal(gc.value.failures.length, 0);
            races.commitRecoveryGc++;
            const observedHead = await service.repo.head(volume.id);
            assert.ok(observedHead === before || observedHead === before + 1);
            if (observedHead === before + 1) advance(next);
            const remaining = await service.applyWal(actor.id, {
              drainId: recovered.drainId,
            });
            assert.equal(remaining.applied, head === before ? 1 : 0);
            if (head === before) advance(next);
            assert.equal(
              await service.confirmPersistence(actor.id, head, {
                drainId: recovered.drainId,
              }),
              false,
            );
            assert.equal(
              await service.confirmPersistence(actor.id, head, {
                drainId: recovered.drainId,
                supervisorNonce: nonce,
              }),
              true,
            );
            await service.finishDrain(actor.id, {
              drainId: recovered.drainId,
              confirmedSeq: head,
              stopProof: {
                sandboxId: actor.sandboxId!,
                bootId: actor.bootId!,
                supervisorNonce: nonce,
                drainId: recovered.drainId,
                stopped: true,
              },
            });
            await newActor();
          } else {
            if (!tree.children.has("x\uFFFD")) {
              const next = copy(tree);
              next.children.set("x\uFFFD", {
                kind: "file",
                text: `replacement-character-${seed}`,
                mode: 0o600,
                time: "0",
              });
              await upload(next, false);
              assert.equal((await service.applyWal(actor.id)).applied, 1);
              advance(next);
              acknowledge();
            }
            actor = (await service.repo.getAttachment(actor.id))!;
            if (head + 1 > actor.slotsUntilSeq) {
              await service.issueSlots(actor);
              actor = (await service.repo.getAttachment(actor.id))!;
            }
            const bad: Manifest = {
              v: 1,
              volume: volume.id,
              attachment: actor.id,
              boot_id: "model-boot",
              seq: head + 1,
              base: head,
              upserts: [{ p: "x\ud800", k: "f", m: 420, s: 0, c: [] }],
            };
            objects.set(
              `${service.volumePrefix(volume.id)}${service.manifestPrefix(actor)}${head + 1}`,
              encodeManifestObject(bad),
            );
            const refused = await service.applyWal(actor.id);
            assert.match(refused.rejected ?? "", /invalid path/);
            invalidAttempts++;
            assert.equal(await service.repo.head(volume.id), head);
            await service.beginRebase(actor.id);
            actor = (await service.repo.getAttachment(actor.id))!;
          }
          await verify(serial % 35 === 0);
        }
        const finalHistories = await verify(true);
        for (const receipt of acknowledged)
          assert.deepEqual(
            finalHistories.get(receipt.seq),
            entries(receipt.tree),
            `acknowledged seq ${receipt.seq} changed`,
          );
        const allIds = new Set(
          acknowledged.flatMap((receipt) =>
            entries(receipt.tree).flatMap((entry) =>
              (entry.c ?? []).map(([id]) => id),
            ),
          ),
        );
        const locations = await service.repo.chunkLocations(volume.id, allIds);
        for (const receipt of acknowledged)
          for (const entry of entries(receipt.tree).filter(
            (entry) => entry.k === "f",
          )) {
            const id = entry.c![0]![0],
              location = locations[id];
            assert.ok(location, `confirmed chunk ${id} was removed`);
            const [key, off, length] = location,
              bytes = objects.get(`${service.volumePrefix(volume.id)}${key}`);
            assert.ok(bytes, `confirmed historical object ${key} was deleted`);
            assert.equal(
              zstdDecompressSync(bytes.subarray(off, off + length)).toString(),
              content(receipt.tree, entry.p),
            );
          }
        assert.equal(
          await service.repo.rejectCount(volume.id),
          invalidAttempts,
        );
        assert.ok(
          deleted.length > 0,
          "seed must exercise actual orphan-object GC deletion",
        );
        t.diagnostic(
          `seed=${seed} steps=${steps} heads=${head} acknowledged=${acknowledged.length} invalidUTF16=${invalidAttempts} hosts=4 GC-deletes=${deleted.length} races=${JSON.stringify(races)}`,
        );
      } catch (error) {
        retainSchema = true;
        durableWrite(
          join(evidenceDirectory, "failure.json"),
          JSON.stringify({
            seed,
            steps,
            head,
            schema,
            volumeId: volume.id,
            log,
            error:
              error instanceof Error
                ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                  }
                : String(error),
          }) + "\n",
        );
        t.diagnostic(
          `failure evidence=${evidenceDirectory}; PostgreSQL schema ${schema} retained`,
        );
        t.diagnostic(JSON.stringify({ seed, steps, head, log }));
        throw error;
      }
    },
  );
