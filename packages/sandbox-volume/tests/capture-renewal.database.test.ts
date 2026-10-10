import { fixtureWriteGrant } from "./fixtures/write-grant";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  rmSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { VolumeService } from "../src/service/volume-service";
import type { CaptureProgress } from "../src/protocol/types";
import type { ObjectStore } from "../src/store/object-store";
import type { VolumeLimits } from "../src/service/quota";
import { encodeManifestObject } from "../src/protocol/manifest";
const url = process.env.SANDBOX_VOLUME_TEST_DATABASE_URL;
const schema = `capture_${randomUUID().replaceAll("-", "")}`;
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
async function fixture(limits?: Partial<VolumeLimits>) {
  const dir = mkdtempSync(join(tmpdir(), "capture-objects-"));
  dirs.push(dir);
  mkdirSync(join(dir, "objects"));
  const path = (key: string) =>
    join(dir, "objects", createHash("sha256").update(key).digest("hex"));
  const signed: string[] = [],
    heads: string[] = [],
    puts: string[] = [];
  let concurrent = 0,
    peak = 0;
  let onHead:
    ((key: string, signal?: AbortSignal) => Promise<void>) | undefined;
  const store: ObjectStore = {
    presignWriteOnceGrant: fixtureWriteGrant,
    presignWriteOnce: async (key) => {
      signed.push(key);
      return `fixture:${key}`;
    },
    presignGet: async (key) => `fixture:${key}`,
    get: async (key) => {
      try {
        return readFileSync(path(key));
      } catch (e: any) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    put: async (key, body) => {
      puts.push(key);
      writeFileSync(path(key), body);
    },
    size: async (key, options) => {
      heads.push(key);
      concurrent++;
      peak = Math.max(peak, concurrent);
      try {
        options?.signal?.throwIfAborted();
        if (onHead) await onHead(key, options?.signal);
        else await new Promise((done) => setTimeout(done, 2));
        options?.signal?.throwIfAborted();
        try {
          return statSync(path(key)).size;
        } catch (e: any) {
          if (e.code === "ENOENT") return null;
          throw e;
        }
      } finally {
        concurrent--;
      }
    },
    copy: async () => {
      throw Error("unused copy");
    },
    deletePrefix: async () => {
      throw Error("forbidden bulk delete");
    },
  };
  const id = randomUUID();
  await pool.query("insert into workspaces values($1)", [id]);
  await pool.query("insert into threads values($1,$1,$1)", [id]);
  const service = new VolumeService({
    db: drizzle(pool),
    store,
    keyPrefix: "capture-test/",
    limits,
  });
  const volume = await service.getOrCreateVolume({
    teamId: id,
    workspaceId: id,
    threadId: id,
  });
  let actor = await service.attach(volume.id, "sandbox-" + id);
  await service.recordBootId(actor.id, "capture-boot");
  await service.issueSlots(actor);
  actor = (await service.repo.getAttachment(actor.id))!;
  signed.length = 0;
  puts.length = 0;
  const packKey = (n: number) =>
    service.volumePrefix(volume.id) +
    service.packPrefix(actor) +
    String(n).padStart(6, "0");
  const pack = (n: number, size = 128) =>
    writeFileSync(path(packKey(n)), Buffer.alloc(size, n % 255));
  const progress = (next = 64): CaptureProgress => ({
    v: 1,
    volume: volume.id,
    attachment: actor.id,
    boot_id: actor.bootId!,
    epoch: actor.epoch,
    base_seq: 0,
    next_pack: next,
    uploaded_packs: next,
    uploaded_chunks: next,
    uploaded_raw_bytes: next * 1024,
    receipt_digest: createHash("sha256").update(String(next)).digest("hex"),
    recent_uploaded_pack_numbers: Array.from(
      { length: Math.min(next, 64) },
      (_, i) => next - Math.min(next, 64) + i,
    ),
  });
  const empty = async () => {
    assert.equal(await service.repo.head(volume.id), 0);
    assert.deepEqual(await service.repo.entries(volume.id), []);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from sandbox_volume_commits where volume_id=$1",
          [volume.id],
        )
      ).rows[0].n,
      0,
    );
  };
  return {
    service,
    store,
    volume,
    actor,
    pack,
    packKey,
    path,
    progress,
    signed,
    heads,
    puts,
    empty,
    peak: () => peak,
    setHead: (fn: typeof onHead) => {
      onHead = fn;
    },
  };
}

test(
  "capture renewal verifies disk objects in bounded windows without confirming data",
  { skip: !url },
  async () => {
    const f = await fixture();
    for (let n = 0; n < 64; n++) f.pack(n);
    const first = await f.service.renewCaptureSlots(f.actor.id, f.progress());
    assert.equal(first.verifiedObjectBytes, 64 * 128);
    assert.ok(Object.isFrozen(first.progress));
    assert.ok(Object.isFrozen(first.progress.recent_uploaded_pack_numbers));
    assert.equal(Reflect.set(first.progress, "next_pack", 999), false);
    assert.equal(
      Reflect.set(first.progress.recent_uploaded_pack_numbers, "0", 999),
      false,
    );

    assert.equal(f.heads.length, 64);
    assert.deepEqual(
      f.heads.sort(),
      Array.from({ length: 64 }, (_, n) => f.packKey(n)).sort(),
    );
    assert.ok(f.peak() <= 4);
    await f.empty();
    assert.equal(await f.service.confirmPersistence(f.actor.id, 1), false);
    assert.equal(
      (await f.service.repo.getAttachment(f.actor.id))!.slotsUntilPack,
      128,
    );
    let body = JSON.parse(readFileSync(f.path(f.puts.at(-1)!), "utf8"));
    assert.equal(Object.keys(body.packs).length, 64);
    assert.equal(Object.keys(body.packs)[0], "64");
    assert.equal(Object.keys(body.manifests)[0], "1");
    f.heads.length = 0;
    f.signed.length = 0;
    for (let n = 64; n < 128; n++) f.pack(n);
    const second = await f.service.renewCaptureSlots(
      f.actor.id,
      f.progress(128),
      first.progress,
    );
    assert.equal(second.verifiedObjectBytes, 64 * 128);
    assert.deepEqual(
      f.heads.sort(),
      Array.from({ length: 64 }, (_, i) => f.packKey(i + 64)).sort(),
    );
    await f.empty();
    body = JSON.parse(readFileSync(f.path(f.puts.at(-1)!), "utf8"));
    assert.equal(Object.keys(body.packs).length, 64);
    assert.equal(Object.keys(body.packs)[0], "128");
  },
);

test(
  "forged shape, out-of-range counters and regressing capture never grant slots",
  { skip: !url },
  async () => {
    const f = await fixture();
    const p = f.progress();
    const accessorTail = [...p.recent_uploaded_pack_numbers];
    Object.defineProperty(accessorTail, "0", {
      get() {
        throw new Error("getter must not execute");
      },
    });
    await assert.rejects(
      f.service.renewCaptureSlots(f.actor.id, {
        ...p,
        recent_uploaded_pack_numbers: accessorTail,
      }),
      /invalid capture progress metadata/,
    );
    await assert.rejects(
      f.service.renewCaptureSlots(f.actor.id, {
        ...p,
        recent_uploaded_pack_numbers: Object.assign(
          [...p.recent_uploaded_pack_numbers],
          { url: "https://untrusted.invalid" },
        ),
      }),
    );

    for (const candidate of [
      null,
      [],
      { ...p, url: "https://untrusted.invalid" },
      { ...p, v: 2 },
      { ...p, next_pack: NaN },
      { ...p, next_pack: 65 },
      { ...p, uploaded_raw_bytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...p, receipt_digest: "z".repeat(64) },
      { ...p, boot_id: "other" },
      { ...p, volume: "other" },
      { ...p, epoch: p.epoch + 1 },
      { ...p, base_seq: 1 },
      { ...p, uploaded_chunks: 0 },
    ])
      await assert.rejects(f.service.renewCaptureSlots(f.actor.id, candidate));
    for (const previous of [
      p,
      { ...p, epoch: p.epoch + 1 },
      { ...p, uploaded_packs: p.uploaded_packs + 1 },
    ])
      await assert.rejects(
        f.service.renewCaptureSlots(f.actor.id, p, previous),
      );
    assert.equal(f.heads.length, 0);
    assert.equal(f.signed.length, 0);
    assert.equal(
      (await f.service.repo.getAttachment(f.actor.id))!.slotsUntilPack,
      64,
    );
    await f.empty();
  },
);

test(
  "missing and oversized real objects deny renewal; caller cancellation also denies it",
  { skip: !url },
  async () => {
    const f = await fixture();
    for (let n = 0; n < 64; n++) f.pack(n);
    rmSync(f.path(f.packKey(63)));
    await assert.rejects(f.service.renewCaptureSlots(f.actor.id, f.progress()));
    assert.equal(f.signed.length, 0);
    f.pack(63);
    truncateSync(f.path(f.packKey(63)), 64 * 1024 ** 2 + 1);
    await assert.rejects(f.service.renewCaptureSlots(f.actor.id, f.progress()));
    assert.equal(f.signed.length, 0);
    f.pack(63);
    for (const signal of [
      AbortSignal.abort(),
      { aborted: false } as AbortSignal,
      Object.create(AbortSignal.prototype),
    ])
      await assert.rejects(
        f.service.renewCaptureSlots(f.actor.id, f.progress(), undefined, {
          signal,
        }),
      );
    const controller = new AbortController();
    let waiting!: () => void;
    const arrived = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    f.setHead(async (_key, signal) => {
      waiting();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        }),
      );
    });
    const result = f.service.renewCaptureSlots(
      f.actor.id,
      f.progress(),
      undefined,
      { signal: controller.signal },
    );
    const rejected = assert.rejects(result);
    await arrived;
    controller.abort();
    await rejected;
    assert.equal(f.signed.length, 0);
    assert.equal(
      (await f.service.repo.getAttachment(f.actor.id))!.slotsUntilPack,
      64,
    );
    await f.empty();
  },
);

test(
  "epoch or head change during HEAD fences upload renewal",
  { skip: !url },
  async () => {
    for (const change of ["epoch", "head"] as const) {
      const f = await fixture();
      for (let n = 0; n < 64; n++) f.pack(n);
      let changed = false;
      if (change === "head")
        await f.store.put(
          f.service.volumePrefix(f.volume.id) +
            f.service.manifestPrefix(f.actor) +
            "1",
          encodeManifestObject({
            v: 1,
            volume: f.volume.id,
            attachment: f.actor.id,
            boot_id: f.actor.bootId!,
            seq: 1,
            base: 0,
            upserts: [{ p: "confirmed", k: "f", m: 420, t: "0", s: 0, c: [] }],
            chunks: {},
          }),
        );
      f.setHead(async () => {
        if (!changed) {
          changed = true;
          if (change === "epoch")
            await f.service.repo.advanceAttachmentEpoch(f.actor.id);
          else assert.equal((await f.service.applyWal(f.actor.id)).applied, 1);
        }
      });
      await assert.rejects(
        f.service.renewCaptureSlots(f.actor.id, f.progress()),
      );
      assert.equal(f.signed.length, 0);
      assert.equal(
        (await f.service.repo.getAttachment(f.actor.id))!.slotsUntilPack,
        64,
      );
    }
  },
);

test(
  "final allocation CAS cannot drift after HEAD validation; legacy publish can re-fetch",
  { skip: !url },
  async () => {
    const f = await fixture();
    for (let n = 0; n < 64; n++) f.pack(n);
    const publish = f.service.publishSlots.bind(f.service);
    f.service.publishSlots = async (actor, options) => {
      await f.service.repo.advanceAttachmentEpoch(actor.id);
      return publish(actor, options);
    };
    await assert.rejects(f.service.renewCaptureSlots(f.actor.id, f.progress()));
    assert.equal(f.signed.length, 0);
    assert.equal(
      (await f.service.repo.getAttachment(f.actor.id))!.slotsUntilPack,
      64,
    );
    await publish(f.actor);
    assert.ok(f.signed.some((key) => key.includes(`/m/${f.actor.epoch + 1}/`)));
    await f.empty();
  },
);

test(
  "receipt-number proof tolerates reserved holes but rejects invented tails and unknown previous objects",
  { skip: !url },
  async () => {
    const f = await fixture();
    const numbers = [0, ...Array.from({ length: 60 }, (_, i) => i + 4)];
    for (const n of numbers) f.pack(n);
    const progress = {
      ...f.progress(),
      uploaded_packs: numbers.length,
      uploaded_chunks: numbers.length,
      uploaded_raw_bytes: numbers.length * 1024,
      recent_uploaded_pack_numbers: numbers,
    };
    const first = await f.service.renewCaptureSlots(f.actor.id, progress);
    assert.equal(first.verifiedObjectBytes, numbers.length * 128);
    assert.deepEqual(f.heads.sort(), numbers.map(f.packKey).sort());
    await f.empty();
    f.heads.length = 0;
    const next = {
      ...f.progress(128),
      uploaded_packs: 125,
      uploaded_chunks: 125,
      uploaded_raw_bytes: 125 * 1024,
    };
    await assert.rejects(
      f.service.renewCaptureSlots(f.actor.id, next, { ...first.progress }),
    );
    assert.equal(f.heads.length, 0);
    for (const bad of [
      [...numbers, 63],
      numbers.slice(1),
      [1, ...numbers.slice(1)],
      [-1, ...numbers.slice(1)],
      [...numbers.slice(0, -1), 64],
    ])
      await assert.rejects(
        f.service.renewCaptureSlots(f.actor.id, {
          ...progress,
          recent_uploaded_pack_numbers: bad,
        }),
      );
    // A valid subsequent short window must retain the old verified tail, not substitute another old number.
    f.pack(64);
    const short = {
      ...progress,
      next_pack: 65,
      uploaded_packs: 62,
      uploaded_chunks: 62,
      uploaded_raw_bytes: 62 * 1024,
      receipt_digest: "a".repeat(64),
      recent_uploaded_pack_numbers: [...numbers, 64],
    };
    await assert.rejects(
      f.service.renewCaptureSlots(
        f.actor.id,
        {
          ...short,
          recent_uploaded_pack_numbers: [
            1,
            ...short.recent_uploaded_pack_numbers.slice(1),
          ],
        },
        first.progress,
      ),
    );
    const second = await f.service.renewCaptureSlots(
      f.actor.id,
      short,
      first.progress,
    );
    assert.equal(second.verifiedObjectBytes, 128);
    await f.empty();
  },
);

test(
  "capture quota uses measured cumulative bytes and conservative unknown prefix, never caller clones",
  { skip: !url },
  async () => {
    const f = await fixture({ maxObjectBytes: 64 * 128 + 63 * 128 });
    for (let n = 0; n < 64; n++) f.pack(n);
    const first = await f.service.renewCaptureSlots(f.actor.id, f.progress());
    f.signed.length = 0;
    for (let n = 64; n < 128; n++) f.pack(n);
    await assert.rejects(
      f.service.renewCaptureSlots(f.actor.id, f.progress(128), first.progress),
    );
    assert.equal(f.signed.length, 0);
    assert.equal(
      (await f.service.repo.getAttachment(f.actor.id))!.slotsUntilPack,
      128,
    );
    await f.empty();
    const unknown = await fixture({ maxObjectBytes: 64 * 1024 ** 2 });
    await unknown.service.issueSlots(unknown.actor);
    for (let n = 64; n < 128; n++) unknown.pack(n);
    await assert.rejects(
      unknown.service.renewCaptureSlots(
        unknown.actor.id,
        unknown.progress(128),
      ),
    );
    await unknown.empty();
    const logical = await fixture({ maxLogicalBytes: 64 * 1024 - 1 });
    await assert.rejects(
      logical.service.renewCaptureSlots(logical.actor.id, logical.progress()),
    );
    assert.equal(logical.heads.length, 0);
  },
);

test(
  "only a matching drain can renew capture and renewal cannot checkpoint or retire it",
  { skip: !url },
  async () => {
    const f = await fixture();
    for (let n = 0; n < 64; n++) f.pack(n);
    const nonce = randomUUID();
    await f.service.bindSupervisorIdentity(f.actor.id, nonce);
    const drain = await f.service.beginDrain(f.actor.id, {
      sandboxId: f.actor.sandboxId!,
      bootId: f.actor.bootId!,
      supervisorNonce: nonce,
      operationId: randomUUID(),
      reason: "capture-test",
    });
    await assert.rejects(f.service.renewCaptureSlots(f.actor.id, f.progress()));
    await assert.rejects(
      f.service.renewCaptureSlots(f.actor.id, f.progress(), undefined, {
        drainId: randomUUID(),
      }),
    );
    assert.equal(f.heads.length, 0);
    await f.service.renewCaptureSlots(f.actor.id, f.progress(), undefined, {
      drainId: drain.drainId,
    });
    await f.empty();
    assert.equal(
      (await f.service.repo.getAttachment(f.actor.id))!.status,
      "draining",
    );
    const row = (
      await pool.query(
        "select confirmed_seq,stopped_at,retired_at from sandbox_volume_drains where id=$1",
        [drain.drainId],
      )
    ).rows[0];
    assert.equal(row.confirmed_seq, null);
    assert.equal(row.stopped_at, null);
    assert.equal(row.retired_at, null);
  },
);
