import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { blake3 } from "@noble/hashes/blake3.js";
import { encodeManifestObject } from "../src/protocol/manifest";
import type { VolumeMetric } from "../src/service/volume-service";
import { fixtureWriteGrant } from "./fixtures/write-grant";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  statSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { VolumeService } from "../src/service/volume-service";
import { VolumeQuotaExceeded } from "../src/service/quota";
import {
  createS3ObjectStore,
  type ObjectStore,
} from "../src/store/object-store";
const url = process.env.SANDBOX_VOLUME_TEST_DATABASE_URL;
const schema = `repair_${randomUUID().replaceAll("-", "")}`;
let admin: Pool, pool: Pool;
const dirs: string[] = [];
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
    "create table workspaces(id text primary key);create table threads(id text primary key,workspace_id text not null,team_id text not null,unique(id,workspace_id,team_id));",
  );
  const migrations = new URL("../../db/drizzle/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((n) => /^\d+_sandbox_volumes?.*\.sql$/.test(n))
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
        await admin.query(`drop schema ${schema} cascade`);
      } finally {
        await admin.end();
      }
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
async function fixture(maxObjectBytes = 64 * 1024) {
  const dir = mkdtempSync(join(tmpdir(), "repair-inventory-"));
  dirs.push(dir);
  const path = (key: string) =>
    join(dir, createHash("sha256").update(key).digest("hex"));
  let copies = 0;
  let onCopy: ((source: string, target: string) => Promise<void>) | undefined;
  const store: ObjectStore = {
    presignWriteOnceGrant: fixtureWriteGrant,
    presignWriteOnce: async (key) => key,
    presignGet: async (key) => key,
    get: async (key) => {
      try {
        return readFileSync(path(key));
      } catch (e: any) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    put: async (key, bytes) => {
      writeFileSync(path(key), bytes);
    },
    size: async (key) => {
      try {
        return statSync(path(key)).size;
      } catch (e: any) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    copy: async (source, target) => {
      copies++;
      if (onCopy) await onCopy(source, target);
      copyFileSync(path(source), path(target));
    },
    deletePrefix: async () => {
      throw Error("bulk deletion forbidden");
    },
    deleteObject: async (key) => {
      try {
        unlinkSync(path(key));
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    },
  };
  const config = {
    db: drizzle(pool),
    store,
    keyPrefix: "repair-fixture/",
    limits: { maxObjectBytes },
    gcGraceMs: 0,
  };
  const service = new VolumeService(config);
  const id = randomUUID();
  await pool.query("insert into workspaces values($1)", [id]);
  await pool.query("insert into threads values($1,$1,$1)", [id]);
  const volume = await service.getOrCreateVolume({
    teamId: id,
    workspaceId: id,
    threadId: id,
  });
  const actor = await service.attach(volume.id, "fixture");
  const key = `att/${actor.id}/p/000000`,
    chunk = "a".repeat(64);
  const bytes = Buffer.from(
    Array.from({ length: 4096 }, (_, i) => (i * 73 + 11) % 251),
  );
  await store.put(service.volumePrefix(volume.id) + key, bytes);
  await service.repo.applyManifest(
    volume.id,
    {
      v: 1,
      volume: volume.id,
      attachment: actor.id,
      boot_id: "boot",
      seq: 1,
      base: 0,
      full: false,
      trigger: "flush",
      upserts: [{ p: "file", k: "f", m: 420, s: 4096, c: [[chunk, 4096]] }],
      deletes: [],
      chunks: {},
      packs: [],
      unstable: [],
      skipped: [],
      ts_ms: 1,
    },
    { [chunk]: [key, 0, 4096, 4096] },
    new Map([[key, 4096]]),
  );
  return {
    service,
    directory: dir,
    store,
    config,
    volume,
    actor,
    key,
    chunk,
    bytes,
    copies: () => copies,
    setCopy: (callback: typeof onCopy) => {
      onCopy = callback;
    },
    physical: () =>
      readdirSync(dir).reduce(
        (sum, name) => sum + statSync(join(dir, name)).size,
        0,
      ),
    read: (key: string) =>
      readFileSync(path(service.volumePrefix(volume.id) + key)),
  };
}
test(
  "repair reserves physical quota before copying and keeps the confirmed original",
  { skip: !url },
  async () => {
    const f = await fixture(4096);
    await assert.rejects(
      f.service.repairPack(f.volume.id, f.key),
      VolumeQuotaExceeded,
    );
    assert.equal(f.copies(), 0);
    assert.equal(f.physical(), 4096);
    assert.deepEqual(f.read(f.key), f.bytes);
    assert.equal(
      (await f.service.repo.chunkLocations(f.volume.id, [f.chunk]))[
        f.chunk
      ]![0],
      f.key,
    );
    assert.equal(await f.service.repo.head(f.volume.id), 1);
  },
);
test(
  "repair retains original inventory and accounts every immutable physical copy",
  { skip: !url },
  async () => {
    const f = await fixture();
    const one = await f.service.repairPack(f.volume.id, f.key);
    const two = await f.service.repairPack(f.volume.id, one);
    for (const key of [f.key, one, two]) {
      assert.deepEqual(f.read(key), f.bytes);
      assert.equal(
        await f.service.repo.registeredPackSize(f.volume.id, key),
        4096,
      );
    }
    assert.equal(f.physical(), 12288);
    assert.equal(
      (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
      f.physical(),
    );
    assert.equal(
      (await f.service.repo.chunkLocations(f.volume.id, [f.chunk]))[
        f.chunk
      ]![0],
      two,
    );
    assert.equal(await f.service.repo.head(f.volume.id), 1);
  },
);

test(
  "failed copy remains charged across service restart and resumes the exact reservation",
  { skip: !url },
  async () => {
    const f = await fixture(8192);
    f.setCopy(async () => {
      throw Error("injected copy transport failure");
    });
    await assert.rejects(
      f.service.repairPack(f.volume.id, f.key),
      /transport failure/,
    );
    const [pending] = await f.service.repo.listPendingRepairs(f.volume.id);
    assert.ok(pending);
    assert.equal(
      (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
      8192,
    );
    assert.equal(f.physical(), 4096);
    assert.deepEqual(f.read(f.key), f.bytes);
    f.setCopy(undefined);
    const restarted = new VolumeService(f.config);
    const target = await restarted.repairPack(f.volume.id, f.key, {
      reservationKey: pending.packKey,
    });
    assert.equal(target, pending.packKey);
    assert.deepEqual(f.read(target), f.bytes);
    assert.deepEqual(await restarted.repo.listPendingRepairs(f.volume.id), []);
    assert.equal(
      (await restarted.repo.getVolume(f.volume.id))!.storedBytes,
      8192,
    );
    await restarted.repo.finishRepair(pending); // Finishing the same durable copy is idempotent.
    assert.equal(
      (await restarted.repo.getVolume(f.volume.id))!.storedBytes,
      8192,
    );
  },
);

test(
  "copy succeeded but reply was lost: restart verifies bytes without a second copy",
  { skip: !url },
  async () => {
    const f = await fixture(8192);
    f.setCopy(async (_source, target) => {
      await f.store.put(target, f.bytes);
      throw Error("injected lost COPY response");
    });
    await assert.rejects(
      f.service.repairPack(f.volume.id, f.key),
      /lost COPY response/,
    );
    const [pending] = await f.service.repo.listPendingRepairs(f.volume.id);
    assert.ok(pending);
    const restarted = new VolumeService(f.config);
    const target = await restarted.repairPack(f.volume.id, f.key, {
      reservationKey: pending.packKey,
    });
    assert.equal(f.copies(), 1);
    assert.equal(target, pending.packKey);
    assert.deepEqual(f.read(target), f.bytes);
    assert.equal(await restarted.repo.head(f.volume.id), 1);
    assert.equal(
      (await restarted.repo.getVolume(f.volume.id))!.storedBytes,
      f.physical(),
    );
  },
);

for (const partial of [false, true])
  test(
    `repair rejects ${partial ? "partial" : "same-size different"} object and retains unknown reservation`,
    { skip: !url },
    async () => {
      const f = await fixture(8192);
      f.setCopy(async (_source, target) => {
        await f.store.put(target, Buffer.alloc(partial ? 2048 : 4096, 99));
        throw Error("uncertain copy");
      });
      await assert.rejects(
        f.service.repairPack(f.volume.id, f.key),
        /uncertain copy/,
      );
      const [pending] = await f.service.repo.listPendingRepairs(f.volume.id);
      assert.ok(pending);
      await assert.rejects(
        new VolumeService(f.config).repairPack(f.volume.id, f.key, {
          reservationKey: pending.packKey,
        }),
        /reservation retained/,
      );
      assert.equal(f.copies(), 1);
      assert.equal(
        (await f.service.repo.listPendingRepairs(f.volume.id)).length,
        1,
      );
      assert.equal(
        (await f.service.repo.chunkLocations(f.volume.id, [f.chunk]))[
          f.chunk
        ]![0],
        f.key,
      );
      assert.equal(
        (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
        8192,
      );
      assert.deepEqual(f.read(f.key), f.bytes);
    },
  );

test(
  "two independent service hosts cannot reserve beyond physical quota",
  { skip: !url },
  async () => {
    const f = await fixture(8192);
    const second = new VolumeService(f.config);
    const results = await Promise.allSettled([
      f.service.repairPack(f.volume.id, f.key),
      second.repairPack(f.volume.id, f.key),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof VolumeQuotaExceeded);
    assert.equal(f.copies(), 1);
    assert.equal(f.physical(), 8192);
    assert.equal(
      (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
      8192,
    );
  },
);

test(
  "repair resume keys are scoped to an existing source and volume",
  { skip: !url },
  async () => {
    const f = await fixture(),
      other = await fixture();
    f.setCopy(async () => {
      throw Error("uncertain");
    });
    await assert.rejects(f.service.repairPack(f.volume.id, f.key), /uncertain/);
    const [pending] = await f.service.repo.listPendingRepairs(f.volume.id);
    assert.ok(pending);
    await assert.rejects(
      other.service.repairPack(other.volume.id, other.key, {
        reservationKey: pending.packKey,
      }),
      /does not exist in this volume/,
    );
    await assert.rejects(
      f.service.repairPack(f.volume.id, "other-source", {
        reservationKey: pending.packKey,
      }),
      /another source/,
    );
    assert.equal(other.copies(), 0);
    assert.equal(f.copies(), 1);
  },
);

test(
  "pending repair pins even an unreferenced source during COPY; completed repair retains history",
  { skip: !url },
  async () => {
    const f = await fixture();
    // A separate already registered but unreferenced pack is eligible for GC without a repair.
    const orphan = `att/${f.actor.id}/p/000001`;
    await f.store.put(f.service.volumePrefix(f.volume.id) + orphan, f.bytes);
    await pool.query(
      "insert into sandbox_volume_packs(volume_id,pack_key,size_bytes) values($1,$2,4096)",
      [f.volume.id, orphan],
    );
    await pool.query(
      "update sandbox_volumes set stored_bytes=8192 where id=$1",
      [f.volume.id],
    );
    await f.service.rollback(f.volume.id, 0);
    assert.deepEqual(
      (await f.service.maintenance.collect(f.volume.id)).candidates,
      [orphan],
    );
    f.setCopy(async () => {
      const gc = await new VolumeService(f.config).maintenance.collect(
        f.volume.id,
        { dryRun: false },
      );
      assert.deepEqual(gc.deleted, []);
      assert.deepEqual(gc.candidates, []);
      assert.equal(
        (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
        12288,
      );
    });
    const copied = await f.service.repairPack(f.volume.id, orphan);
    f.setCopy(undefined);
    const gc = await f.service.maintenance.collect(f.volume.id, {
      dryRun: false,
    });
    assert.deepEqual(new Set(gc.deleted), new Set([orphan, copied]));
    assert.deepEqual(f.read(f.key), f.bytes); // Historical file remains reachable.
    assert.equal(
      (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
      4096,
    );
    assert.deepEqual(
      (await f.service.repo.entriesAt(f.volume.id, 1))[0]!.chunks,
      [[f.chunk, 4096]],
    );
  },
);

test(
  "GC failure retains indexed bytes; stale hash reuse is rejected and fresh upload survives finalize",
  { skip: !url },
  async () => {
    const f = await fixture();
    const orphan = `att/${f.actor.id}/p/000001`,
      orphanChunk = "b".repeat(64);
    await f.store.put(f.service.volumePrefix(f.volume.id) + orphan, f.bytes);
    await pool.query(
      "insert into sandbox_volume_packs(volume_id,pack_key,size_bytes) values($1,$2,4096)",
      [f.volume.id, orphan],
    );
    await pool.query(
      "insert into sandbox_volume_chunks(volume_id,chunk_id,pack_key,off,compressed_length,raw_length) values($1,decode($2,'hex'),$3,0,4096,4096)",
      [f.volume.id, orphanChunk, orphan],
    );
    await pool.query(
      "update sandbox_volumes set stored_bytes=8192 where id=$1",
      [f.volume.id],
    );
    await f.service.rollback(f.volume.id, 0);
    const realDelete = f.store.deleteObject!;
    f.store.deleteObject = async () => {
      throw Error("uncertain DELETE transport");
    };
    const first = await f.service.maintenance.collect(f.volume.id, {
      dryRun: false,
    });
    assert.deepEqual(first.failures, [orphan]);
    assert.deepEqual(first.deleted, []);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from sandbox_volume_chunks where volume_id=$1 and pack_key=$2",
          [f.volume.id, orphan],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
      8192,
    );
    assert.equal(
      await f.service.repo.chunkKnown(f.volume.id, orphanChunk),
      false,
    );
    assert.equal(
      await f.service.repo.chunkLength(f.volume.id, orphanChunk),
      null,
    );
    assert.deepEqual(
      await f.service.repo.chunkLocations(f.volume.id, [orphanChunk]),
      {},
    );
    let replacement = "";
    f.store.deleteObject = async (key) => {
      const actor = await f.service.attach(
        f.volume.id,
        "new-host-during-delete",
      );
      const head = await f.service.repo.head(f.volume.id);
      const m = {
        v: 1 as const,
        volume: f.volume.id,
        attachment: actor.id,
        boot_id: "boot",
        seq: head + 1,
        base: head,
        full: false,
        trigger: "flush" as const,
        upserts: [
          {
            p: "reuploaded",
            k: "f" as const,
            m: 420,
            s: 4096,
            c: [[orphanChunk, 4096] as [string, number]],
          },
        ],
        deletes: [],
        chunks: {},
        packs: [],
        unstable: [],
        skipped: [],
        ts_ms: 1,
      };
      await assert.rejects(
        f.service.repo.applyManifest(f.volume.id, m, {}, new Map()),
        /GC-withdrawn/,
      );
      assert.equal(await f.service.repo.head(f.volume.id), head);
      replacement = `att/${actor.id}/p/000000`;
      await f.store.put(
        f.service.volumePrefix(f.volume.id) + replacement,
        f.bytes,
      );
      await f.service.repo.applyManifest(
        f.volume.id,
        m,
        { [orphanChunk]: [replacement, 0, 4096, 4096] },
        new Map([[replacement, 4096]]),
      );
      await realDelete(key);
    };
    const second = await f.service.maintenance.collect(f.volume.id, {
      dryRun: false,
    });
    assert.deepEqual(second.deleted, [orphan]);
    assert.deepEqual(second.failures, []);
    assert.equal(
      (await f.service.repo.chunkLocations(f.volume.id, [orphanChunk]))[
        orphanChunk
      ]![0],
      replacement,
    );
    assert.deepEqual(f.read(replacement), f.bytes);
    assert.equal(
      (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
      8192,
    );
    assert.equal(f.physical(), 8192);
  },
);

for (const status of ["retired", "superseded"])
  test(
    `${status} actor PUT grant pins its namespace and repair copies until explicit test expiry`,
    { skip: !url },
    async () => {
      const f = await fixture();
      const orphan = `att/${f.actor.id}/p/000001`,
        derived = orphan + ".r" + "c".repeat(24);
      for (const key of [orphan, derived]) {
        await f.store.put(f.service.volumePrefix(f.volume.id) + key, f.bytes);
        await pool.query(
          "insert into sandbox_volume_packs(volume_id,pack_key,size_bytes) values($1,$2,4096)",
          [f.volume.id, key],
        );
      }
      await pool.query(
        "update sandbox_volumes set stored_bytes=12288 where id=$1",
        [f.volume.id],
      );
      await f.service.repo.reserveSlots(f.actor, 64, 64, 3600);
      await f.service.rollback(f.volume.id, 0);
      await pool.query(
        "update sandbox_volume_attachments set status=$2 where id=$1",
        [f.actor.id, status],
      );
      const protectedResult = await f.service.maintenance.collect(f.volume.id, {
        dryRun: false,
      });
      assert.deepEqual(protectedResult.candidates, []);
      assert.deepEqual(protectedResult.deleted, []);
      assert.equal(f.physical(), 12288);
      // Advance only this fixture's recorded grant expiry. No real signed URLs are issued here.
      await pool.query(
        "update sandbox_volume_attachments set slots_expire_at=now()-interval '1 second' where id=$1",
        [f.actor.id],
      );
      const expired = await f.service.maintenance.collect(f.volume.id, {
        dryRun: false,
      });
      assert.deepEqual(new Set(expired.deleted), new Set([orphan, derived]));
      assert.deepEqual(f.read(f.key), f.bytes);
      assert.equal(f.physical(), 4096);
    },
  );

test(
  "actual Node SIGKILL after fsynced COPY resumes in a fresh process without copying again",
  { skip: !url },
  async () => {
    const f = await fixture(8192);
    const control = mkdtempSync(join(tmpdir(), "repair-child-control-"));
    dirs.push(control);
    const counter = join(control, "copies"),
      configPath = join(control, "config.json");
    const worker = fileURLToPath(
      new URL("./fixtures/repair-process.ts", import.meta.url),
    );
    const config = {
      url: url!,
      schema,
      directory: f.directory,
      counter,
      volumeId: f.volume.id,
      sourceKey: f.key,
    };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const initial = await f.service.repo.entries(f.volume.id);
    const initialHash = createHash("sha256").update(f.bytes).digest("hex");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, configPath, "crash-after-copy"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr!.on("data", (data) => {
      stderr += String(data);
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      const marker = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              Error(
                `repair worker did not reach durable COPY boundary: ${stderr}`,
              ),
            ),
          60_000,
        );
        child.once("message", (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(Error(`repair worker exited before marker: ${stderr}`));
        });
      });
      assert.equal(marker.phase, "copy-durable-before-finish");
      assert.equal(marker.pid, child.pid);
      const [pending] = await f.service.repo.listPendingRepairs(f.volume.id);
      assert.ok(pending);
      assert.equal(marker.source, f.service.volumePrefix(f.volume.id) + f.key);
      assert.equal(
        marker.target,
        f.service.volumePrefix(f.volume.id) + pending.packKey,
      );
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(child.kill("SIGKILL"), true); // Only the actual ChildProcess PID we just authenticated.
      const dead = await exited;
      assert.equal(dead.code, null);
      assert.equal(dead.signal, "SIGKILL");
      assert.equal(readFileSync(counter, "utf8"), "1");
      assert.equal(
        createHash("sha256").update(f.read(pending.packKey)).digest("hex"),
        initialHash,
      );
      assert.equal(
        createHash("sha256").update(f.read(f.key)).digest("hex"),
        initialHash,
      );
      assert.equal(
        (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
        8192,
      );
      assert.equal(
        (await f.service.repo.listPendingRepairs(f.volume.id)).length,
        1,
      );
      assert.equal(
        (await f.service.maintenance.collect(f.volume.id, { dryRun: false }))
          .pinned,
        true,
      );
      assert.deepEqual(await f.service.repo.entries(f.volume.id), initial);
      assert.equal(
        (await f.service.repo.chunkLocations(f.volume.id, [f.chunk]))[
          f.chunk
        ]![0],
        f.key,
      );
      assert.equal(await f.service.repo.head(f.volume.id), 1);
      writeFileSync(
        configPath,
        JSON.stringify({ ...config, reservationKey: pending.packKey }),
        { mode: 0o600 },
      );
      const resumed = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", worker, configPath, "resume"],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const result = JSON.parse(resumed.stdout);
      assert.notEqual(result.pid, child.pid);
      assert.notEqual(result.pid, process.pid);
      assert.equal(result.key, pending.packKey);
      assert.equal(result.copies, 1);
      assert.equal(readFileSync(counter, "utf8"), "1");
      assert.deepEqual(
        await f.service.repo.listPendingRepairs(f.volume.id),
        [],
      );
      assert.deepEqual(await f.service.repo.entries(f.volume.id), initial);
      assert.equal(
        (await f.service.repo.getVolume(f.volume.id))!.storedBytes,
        8192,
      );
      assert.equal(
        (await f.service.repo.chunkLocations(f.volume.id, [f.chunk]))[
          f.chunk
        ]![0],
        pending.packKey,
      );
      assert.equal(
        createHash("sha256").update(f.read(pending.packKey)).digest("hex"),
        initialHash,
      );
      assert.equal(await f.service.repo.head(f.volume.id), 1);
      console.log(
        JSON.stringify({
          repairProcessCrash: "SIGKILL",
          boundary: "real-file-and-directory-fsync-before-finish",
          killedPid: child.pid,
          recoveryPid: result.pid,
          copyCount: 1,
          bytes: f.bytes.length,
          sourceAndTargetSha256: initialHash,
          storage: "local disk fixture + real isolated PostgreSQL; not R2",
        }),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
  },
);

function actualFixtureSigner() {
  // Real installed SDK signature construction, no HTTP or real cloud credentials.
  return createS3ObjectStore({
    bucket: "grant-expiry-fixture",
    region: "auto",
    endpoint: "https://objects.invalid",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
  });
}
test(
  "actual SDK slow signing persists its later expiry before a slots file is published",
  { skip: !url },
  async () => {
    const f = await fixture(),
      signer = actualFixtureSigner();
    let before = 0,
      latest = 0,
      signed = 0,
      published = 0;
    f.store.presignWriteOnceGrant = async (key) => {
      if (++signed === 1) {
        before = (await f.service.repo.getAttachment(
          f.actor.id,
        ))!.slotsExpireAt!.getTime();
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      const grant = await signer.presignWriteOnceGrant!(key, 60);
      latest = Math.max(latest, grant.expiresAt.getTime());
      return grant;
    };
    const put = f.store.put;
    f.store.put = async (...args) => {
      assert.ok(
        (await f.service.repo.getAttachment(
          f.actor.id,
        ))!.slotsExpireAt!.getTime() >= latest,
      );
      published++;
      await put(...args);
    };
    await new VolumeService({
      ...f.config,
      presignTtlSeconds: 60,
    }).publishSlots(f.actor);
    assert.ok(
      latest > before,
      "the last actual signature must outlive the before-sign reservation",
    );
    assert.equal(published, 1);
    assert.ok(
      (await f.service.repo.getAttachment(
        f.actor.id,
      ))!.slotsExpireAt!.getTime() >= latest,
    );
  },
);

test(
  "grant clock rollback/skew and mutable Dates cannot shrink the persisted maximum, even on a later failure",
  { skip: !url },
  async () => {
    const f = await fixture();
    const future = Date.now() + 4 * 3600_000,
      earlier = Date.now() + 2 * 3600_000;
    const mutable = new Date(future);
    let count = 0,
      puts = 0;
    f.store.presignWriteOnceGrant = async (key) => {
      if (++count === 1) return { url: key, expiresAt: mutable };
      mutable.setTime(1); // Mutating a previously returned Date must not alter host authority.
      return { url: key, expiresAt: new Date(earlier) };
    };
    f.store.put = async () => {
      puts++;
    };
    await f.service.publishSlots(f.actor);
    assert.equal(
      (await f.service.repo.getAttachment(
        f.actor.id,
      ))!.slotsExpireAt!.getTime(),
      future,
    );
    f.store.presignWriteOnceGrant = async () => {
      throw Error("signer failed before finalization");
    };
    await assert.rejects(f.service.publishSlots(f.actor), /signer failed/);
    assert.equal(
      (await f.service.repo.getAttachment(
        f.actor.id,
      ))!.slotsExpireAt!.getTime(),
      future,
    );
    assert.equal(puts, 1);
  },
);

test(
  "an already-expired actual SDK grant prevents publishing the entire slots bundle",
  { skip: !url },
  async () => {
    const f = await fixture(),
      signer = actualFixtureSigner();
    let count = 0,
      puts = 0;
    f.store.presignWriteOnceGrant = async (key) => {
      const first = ++count === 1;
      const grant = await signer.presignWriteOnceGrant!(key, first ? 1 : 60);
      if (first) await new Promise((resolve) => setTimeout(resolve, 1100));
      return grant;
    };
    f.store.put = async () => {
      puts++;
    };
    await assert.rejects(
      f.service.publishSlots(f.actor),
      /expired before publication/,
    );
    assert.equal(puts, 0);
    assert.equal(await f.service.repo.head(f.volume.id), 1);
  },
);

for (const drift of ["boot", "epoch", "quarantine", "capture-head"])
  test(
    `late ${drift} drift cannot publish signed upload authority`,
    { skip: !url },
    async () => {
      const f = await fixture();
      await f.service.recordBootId(f.actor.id, "grant-boot");
      const actor = (await f.service.repo.getAttachment(f.actor.id))!;
      let count = 0,
        puts = 0;
      f.store.presignWriteOnceGrant = async (key) => {
        if (++count === 1) {
          if (drift === "boot")
            await pool.query(
              "update sandbox_volume_attachments set boot_id='changed' where id=$1",
              [actor.id],
            );
          if (drift === "epoch")
            await f.service.repo.advanceAttachmentEpoch(actor.id);
          if (drift === "quarantine")
            await f.service.quarantineAttachment(
              actor.id,
              "concurrent unknown writer",
            );
          if (drift === "capture-head")
            await f.service.repo.applyManifest(
              f.volume.id,
              {
                v: 1,
                volume: f.volume.id,
                attachment: actor.id,
                boot_id: "grant-boot",
                seq: 2,
                base: 1,
                full: false,
                trigger: "flush",
                upserts: [{ p: "concurrent", k: "d", m: 493 }],
                deletes: [],
                chunks: {},
                packs: [],
                unstable: [],
                skipped: [],
                ts_ms: 1,
              },
              {},
              new Map(),
            );
        }
        return { url: key, expiresAt: new Date(Date.now() + 3600_000) };
      };
      f.store.put = async () => {
        puts++;
      };
      await assert.rejects(
        f.service.publishSlots(
          actor,
          drift === "capture-head"
            ? {
                expectedCapture: {
                  bootId: "grant-boot",
                  epoch: actor.epoch,
                  baseSeq: 1,
                },
              }
            : {},
        ),
        /actor changed/,
      );
      assert.ok(count > 0);
      assert.equal(puts, 0);
      assert.deepEqual(f.read(f.key), f.bytes);
    },
  );

test(
  "a string-only signer and invalid expiry metadata fail closed without publishing",
  { skip: !url },
  async () => {
    const f = await fixture();
    let writes = 0,
      signs = 0;
    f.store.put = async () => {
      writes++;
    };
    f.store.presignWriteOnce = async (key) => {
      signs++;
      return key;
    };
    f.store.presignWriteOnceGrant = undefined;
    await assert.rejects(
      f.service.publishSlots(f.actor),
      /authoritative signed grant expiry/,
    );
    assert.equal(signs, 0);
    assert.equal(writes, 0);
    f.store.presignWriteOnceGrant = async (key) => ({
      url: key,
      expiresAt: new Date(NaN),
    });
    await assert.rejects(
      f.service.publishSlots(f.actor),
      /invalid signed write grant metadata/,
    );
    assert.equal(writes, 0);
  },
);

for (const observer of ["record", "throw", "reject"] as const)
  test(
    `WAL observer ${observer} preserves the same confirmed data and exposes only numeric/category metrics`,
    { skip: !url },
    async () => {
      const f = await fixture();
      await f.service.recordBootId(f.actor.id, "metric-boot");
      await f.service.issueSlots(f.actor);
      const seen: Readonly<VolumeMetric>[] = [];
      const service = new VolumeService({
        ...f.config,
        onMetric: (event) => {
          seen.push(event);
          if (observer === "throw") throw Error("synthetic observer failure");
          if (observer === "reject")
            return Promise.reject(Error("synthetic async observer failure"));
        },
      });
      const one = Buffer.from("one"),
        two = Buffer.from("two");
      const a = Buffer.from(blake3(one)).toString("hex"),
        b = Buffer.from(blake3(two)).toString("hex");
      const keys = [`att/${f.actor.id}/p/000001`, `att/${f.actor.id}/p/000002`];
      const packed = [zstdCompressSync(one), zstdCompressSync(two)];
      for (let n = 0; n < keys.length; n++)
        await f.store.put(
          service.volumePrefix(f.volume.id) + keys[n]!,
          packed[n]!,
        );
      const body = encodeManifestObject({
        v: 1,
        volume: f.volume.id,
        attachment: f.actor.id,
        boot_id: "metric-boot",
        seq: 2,
        base: 1,
        full: false,
        trigger: "flush",
        upserts: [
          {
            p: "timed",
            k: "f",
            m: 420,
            t: "0",
            s: 9,
            c: [
              [a, 3],
              [b, 3],
              [a, 3],
            ],
          },
        ],
        deletes: [],
        chunks: {
          [a]: [keys[0]!, 0, packed[0]!.length, 3],
          [b]: [keys[1]!, 0, packed[1]!.length, 3],
        },
        packs: keys.map(
          (key, index) => [key, packed[index]!.length] as [string, number],
        ),
        unstable: [],
        skipped: [],
        ts_ms: 1,
      });
      await f.store.put(
        `${service.volumePrefix(f.volume.id)}att/${f.actor.id}/m/0/2`,
        body,
      );
      const result = await service.applyWal(f.actor.id);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(result.applied, 1);
      assert.equal(result.rejected, null);
      assert.equal(await service.confirmPersistence(f.actor.id, 2), true);
      const entry = (await service.repo.entries(f.volume.id)).find(
        (row) => row.path === "timed",
      )!;
      const locations = await service.repo.chunkLocations(f.volume.id, [a, b]);
      const content = Buffer.concat(
        entry.chunks.map(([id]) => {
          const [key, off, size] = locations[id]!;
          return zstdDecompressSync(f.read(key).subarray(off, off + size));
        }),
      );
      assert.equal(content.toString(), "onetwoone");
      assert.deepEqual(f.read(f.key), f.bytes);
      assert.equal(await service.repo.head(f.volume.id), 2);
      const heads = seen.filter((event) => event.phase === "pack_heads");
      assert.equal(heads.length, 1);
      assert.equal(heads[0]!.count, 2);
      assert.equal(heads[0]!.maxInFlight, 2);
      assert.equal(heads[0]!.missing, 0);
      assert.equal(heads[0]!.failed, 0);
      for (const phase of [
        "manifest_get",
        "manifest_parse",
        "chunk_lookup",
        "manifest_validate",
        "manifest_apply",
        "pack_heads",
      ])
        assert.ok(seen.some((event) => event.phase === phase));
      assert.ok(
        seen.some(
          (event) =>
            event.phase === "manifest_get" && event.outcome === "missing",
        ),
      );
      assert.equal(
        service.metricObserverFailures,
        observer === "record" ? 0 : seen.length,
      );
      const allowed = new Set([
        "phase",
        "durationMs",
        "outcome",
        "bytes",
        "count",
        "sumMs",
        "wallMs",
        "maxInFlight",
        "missing",
        "failed",
      ]);
      for (const event of seen) {
        assert.ok(Object.isFrozen(event));
        for (const [key, value] of Object.entries(event)) {
          assert.ok(allowed.has(key));
          if (key !== "phase" && key !== "outcome")
            assert.ok(
              typeof value === "number" && Number.isFinite(value) && value >= 0,
            );
        }
        assert.ok(!JSON.stringify(event).includes(f.actor.id));
        assert.ok(!JSON.stringify(event).includes(f.volume.id));
      }
    },
  );

for (const fault of [
  "missing",
  "oversize",
  "transport",
  "mixed",
  "epoch",
] as const)
  test(
    `bounded HEAD ${fault} preserves the confirmed tree and receipt watermark`,
    { skip: !url },
    async () => {
      const f = await fixture();
      await f.service.recordBootId(f.actor.id, "heads-boot");
      await f.service.issueSlots(f.actor);
      const before = await f.service.repo.entries(f.volume.id);
      const keys = Array.from(
        { length: 4 },
        (_, n) => `att/${f.actor.id}/p/${String(n + 1).padStart(6, "0")}`,
      );
      const chunks: Record<string, [string, number, number, number]> = {},
        refs: Array<[string, number]> = [];
      const packs: Array<[string, number]> = [];
      for (let n = 0; n < keys.length; n++) {
        const raw = Buffer.from(`pack-${n}`),
          packed = zstdCompressSync(raw),
          id = Buffer.from(blake3(raw)).toString("hex");
        chunks[id] = [keys[n]!, 0, packed.length, raw.length];
        refs.push([id, raw.length]);
        packs.push([keys[n]!, packed.length]);
        await f.store.put(
          f.service.volumePrefix(f.volume.id) + keys[n]!,
          packed,
        );
      }
      const body = encodeManifestObject({
        v: 1,
        volume: f.volume.id,
        attachment: f.actor.id,
        boot_id: "heads-boot",
        seq: 2,
        base: 1,
        full: false,
        trigger: "flush",
        upserts: [{ p: "pending", k: "f", m: 420, t: "0", s: 24, c: refs }],
        deletes: [],
        chunks,
        packs,
        unstable: [],
        skipped: [],
        ts_ms: 1,
      });
      await f.store.put(
        `${f.service.volumePrefix(f.volume.id)}att/${f.actor.id}/m/0/2`,
        body,
      );
      const realSize = f.store.size;
      let calls = 0,
        settled = 0;
      f.store.size = async (key, options) => {
        const call = calls++;
        try {
          await new Promise((resolve) => setImmediate(resolve));
          if (fault === "missing" || (fault === "mixed" && call === 0))
            return null;
          if (fault === "oversize") return 64 * 1024 ** 2 + 1;
          if (fault === "transport" || fault === "mixed")
            throw Error("synthetic HEAD timeout");
          if (fault === "epoch" && call === 0)
            await f.service.repo.advanceAttachmentEpoch(f.actor.id);
          return await realSize(key, options);
        } finally {
          settled++;
        }
      };
      if (fault === "missing" || fault === "oversize")
        assert.ok((await f.service.applyWal(f.actor.id)).rejected);
      else await assert.rejects(f.service.applyWal(f.actor.id));
      assert.equal(calls, 4);
      assert.equal(settled, 4);
      assert.equal(await f.service.repo.head(f.volume.id), 1);
      assert.deepEqual(await f.service.repo.entries(f.volume.id), before);
      assert.equal(await f.service.confirmPersistence(f.actor.id, 2), false);
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from sandbox_volume_commits where volume_id=$1 and seq=2",
            [f.volume.id],
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(f.read(f.key), f.bytes);
      if (fault !== "epoch") {
        f.store.size = realSize;
        assert.equal((await f.service.applyWal(f.actor.id)).applied, 1);
        assert.equal(await f.service.confirmPersistence(f.actor.id, 2), true);
      }
    },
  );
