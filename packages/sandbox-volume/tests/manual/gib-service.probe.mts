import { fixtureWriteGrant } from "../fixtures/write-grant";
import assert from "node:assert/strict";
import { createHash, createCipheriv, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { blake3 } from "@noble/hashes/blake3.js";
import { VolumeService } from "../../src/service/volume-service";
import { encodeManifestObject } from "../../src/protocol/manifest";
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const req = createRequire(import.meta.url);
const { Pool } = req("pg");
const { drizzle } = req("drizzle-orm/node-postgres");
const root = process.env.PROBE_ROOT!;
assert.match(root, /^\/(?:private\/)?tmp\/swvol-gb-[A-Za-z0-9_-]+$/);
const url = process.env.SANDBOX_VOLUME_TEST_DATABASE_URL!;
assert.ok(root && url);
const databaseUrl = new URL(url);
assert.ok(
  databaseUrl.protocol === "postgres:" ||
    databaseUrl.protocol === "postgresql:",
);
assert.equal(databaseUrl.username, "volume_test");
assert.equal(databaseUrl.password, "volume_test");
assert.equal(databaseUrl.hostname, "127.0.0.1");
assert.equal(databaseUrl.port, "55429");
assert.equal(databaseUrl.pathname, "/volume_test");
assert.equal(databaseUrl.search, "");
assert.equal(databaseUrl.hash, "");
const sha = (b: any) => createHash("sha256").update(b).digest("hex");
const chunkHash = (b: any) => Buffer.from(blake3(b)).toString("hex");
const event = (phase: string, extra = {}) =>
  console.log(
    JSON.stringify({
      phase,
      time: new Date().toISOString(),
      rss: process.memoryUsage().rss,
      ...extra,
    }),
  );
function durable(path: string, b: any) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const fd = fs.openSync(path, "wx", 0o600);
  try {
    fs.writeFileSync(fd, b);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const parent = fs.openSync(dirname(path), "r");
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
const objectPath = (key: string) => join(root, "objects", sha(key));
const store = {
  presignWriteOnceGrant: fixtureWriteGrant,
  async presignWriteOnce(k: string) {
    return "fixture:" + k;
  },
  async presignGet(k: string) {
    return "fixture:" + k;
  },
  async get(k: string, o?: any) {
    try {
      const p = objectPath(k);
      if (o && fs.statSync(p).size > o.maxBytes) throw Error("limit");
      return fs.readFileSync(p);
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },
  async put(k: string, b: any) {
    durable(objectPath(k), b);
  },
  async size(k: string) {
    try {
      return fs.statSync(objectPath(k)).size;
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },
  async copy() {
    throw Error("unused copy");
  },
  async deletePrefix() {
    throw Error("forbidden broad deletion");
  },
  async deleteObject(k: string) {
    fs.unlinkSync(objectPath(k));
  },
};
const mode = process.argv[2] ?? "generate";
let meta: any;
if (mode === "generate") {
  assert.ok(
    !fs.existsSync(join(root, "meta.json")),
    "use a fresh PROBE_ROOT; existing evidence must not be overwritten",
  );
  const schema = "gb_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  meta = {
    schema,
    keyPrefix: "gb/",
    volumeId: "",
    attachmentId: "",
    seed: "swvol-228-2gib-v1",
    bytes: 2 * 1024 ** 3,
  };
} else meta = JSON.parse(fs.readFileSync(join(root, "meta.json"), "utf8"));
assert.match(meta.schema, /^gb_[a-f0-9]{32}$/);
const pool = new Pool({
  connectionString: url,
  options: `-c search_path=${meta.schema}`,
  max: 8,
});
const service = new VolumeService({
  db: drizzle(pool),
  store,
  keyPrefix: meta.keyPrefix,
  gcGraceMs: 0,
});
const C = 256 * 1024,
  N = 8192;
const cipher = () =>
  createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update(meta.seed).digest(),
    Buffer.alloc(16),
  );
async function verify(seq: number, ledger: any, restore: boolean) {
  const rows = await service.repo.entriesAt(meta.volumeId, seq);
  const expectedTree = JSON.parse(
    fs.readFileSync(join(root, "tree-v1.json"), "utf8"),
  )
    .filter(
      (e: any) =>
        seq !== 2 || !(e.p === "small/g0" || e.p.startsWith("small/g0/")),
    )
    .map((e: any) => ({
      p: e.p,
      k: e.k,
      m: e.m,
      t: seq === 2 && e.p === "big.bin" ? "1" : e.t,
    }));
  const sort = (a: any, b: any) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
  assert.deepEqual(
    rows
      .map((e: any) => ({
        p: e.path,
        k: e.kind,
        m: e.mode,
        t: e.mtimeNs.toString(),
      }))
      .sort(sort),
    expectedTree.sort(sort),
  );
  const files = rows.filter((e: any) => e.kind === "f");
  assert.equal(files.length, Object.keys(ledger).length);
  const locations = await service.repo.chunkLocations(
    meta.volumeId,
    files.flatMap((e: any) => e.chunks.map(([id]: any) => id)),
  );
  let bytes = 0;
  const destination = join(root, "restored");
  if (restore) fs.rmSync(destination, { recursive: true, force: true });
  for (const entry of files) {
    const expected = ledger[entry.path];
    assert.ok(expected, entry.path);
    const h = createHash("sha256");
    let size = 0;
    let fd: number | undefined;
    if (restore) {
      const p = join(destination, entry.path);
      fs.mkdirSync(dirname(p), { recursive: true });
      fd = fs.openSync(p, "wx");
    }
    try {
      for (const [id, len] of entry.chunks) {
        const [key, off, clen, rlen] = locations[id];
        assert.equal(len, rlen);
        const compressed = Buffer.alloc(clen);
        const pack = fs.openSync(
          objectPath(service.volumePrefix(meta.volumeId) + key),
          "r",
        );
        try {
          assert.equal(fs.readSync(pack, compressed, 0, clen, off), clen);
        } finally {
          fs.closeSync(pack);
        }
        const raw = zstdDecompressSync(compressed);
        assert.equal(raw.length, len);
        assert.equal(chunkHash(raw), id);
        h.update(raw);
        size += raw.length;
        if (fd !== undefined) fs.writeSync(fd, raw);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    assert.equal(size, expected.size);
    assert.equal(
      h.digest("hex"),
      expected.sha256,
      `seq=${seq} path=${entry.path}`,
    );
    bytes += size;
  }
  event("verified", { seq, files: files.length, bytes, restore });
  return bytes;
}
try {
  if (mode === "generate") {
    await pool.query(
      "create table workspaces(id text primary key); create table threads(id text primary key,workspace_id text not null,team_id text not null,unique(id,workspace_id,team_id));",
    );
    const migrations = join(repo, "packages/db/drizzle");
    for (const n of fs
      .readdirSync(migrations)
      .filter((n) => /^\d+_sandbox_volumes?.*\.sql$/.test(n))
      .sort())
      await pool.query(
        fs
          .readFileSync(join(migrations, n), "utf8")
          .replaceAll('"public".', `"${meta.schema}".`),
      );
    await pool.query(
      "insert into workspaces values('gb'); insert into threads values('gb','gb','gb')",
    );
    const volume = await service.getOrCreateVolume({
      teamId: "gb",
      workspaceId: "gb",
      threadId: "gb",
    });
    meta.volumeId = volume.id;
    const actor = await service.attach(volume.id, "gb-client");
    meta.attachmentId = actor.id;
    await service.recordBootId(actor.id, "gb-boot");
    await service.issueSlots(actor);
    await service.issueSlots(actor);
    durable(join(root, "meta.json"), JSON.stringify(meta));
    const entries: any[] = [{ p: "small", k: "d", m: 493, t: "0" }];
    for (let g = 0; g < 64; g++)
      entries.push({ p: `small/g${g}`, k: "d", m: 493, t: "0" });
    const big: any = {
      p: "big.bin",
      k: "f",
      m: 420,
      t: "0",
      s: 1024 ** 3,
      c: [],
    };
    entries.push(big);
    const chunks: any = {},
      ledger: any = {};
    const c = cipher();
    const bigH = createHash("sha256");
    const bigPath = join(root, "client", "big.bin");
    fs.mkdirSync(dirname(bigPath), { recursive: true });
    const bigFd = fs.openSync(bigPath, "wx");
    let packBuffers: Buffer[] = [],
      packBytes = 0,
      packIndex = 0,
      totalPacked = 0;
    const flush = async () => {
      await store.put(
        service.volumePrefix(volume.id) +
          service.packPrefix(actor) +
          String(packIndex).padStart(6, "0"),
        Buffer.concat(packBuffers),
      );
      totalPacked += packBytes;
      packBuffers = [];
      packBytes = 0;
      packIndex++;
    };
    try {
      for (let i = 0; i < N; i++) {
        const raw = c.update(Buffer.alloc(C));
        const id = chunkHash(raw),
          z = zstdCompressSync(raw);
        const key =
          service.packPrefix(actor) + String(packIndex).padStart(6, "0");
        chunks[id] = [key, packBytes, z.length, raw.length];
        packBuffers.push(z);
        packBytes += z.length;
        if (i < 4096) {
          big.c.push([id, C]);
          bigH.update(raw);
          fs.writeSync(bigFd, raw);
        } else {
          const n = i - 4096,
            p = `small/g${Math.floor(n / 64)}/f${n}.bin`;
          entries.push({ p, k: "f", m: 420, t: "0", s: C, c: [[id, C]] });
          ledger[p] = { size: C, sha256: sha(raw) };
          durable(join(root, "client", p), raw);
        }
        if ((i + 1) % 64 === 0) await flush();
        if ((i + 1) % 1024 === 0)
          event("generated", {
            chunks: i + 1,
            rawBytes: (i + 1) * C,
            packedBytes: totalPacked,
          });
      }
      fs.fsyncSync(bigFd);
    } finally {
      fs.closeSync(bigFd);
    }
    assert.equal(Object.keys(chunks).length, N);
    assert.equal(packIndex, 128);
    ledger["big.bin"] = { size: 1024 ** 3, sha256: bigH.digest("hex") };
    durable(join(root, "oracle-v1.json"), JSON.stringify(ledger));
    durable(join(root, "tree-v1.json"), JSON.stringify(entries));
    const manifest = {
      v: 1,
      volume: volume.id,
      attachment: actor.id,
      boot_id: "gb-boot",
      seq: 1,
      base: 0,
      full: true,
      upserts: entries,
      chunks,
    };
    await store.put(
      service.volumePrefix(volume.id) + service.manifestPrefix(actor) + "1",
      encodeManifestObject(manifest),
    );
    const start = Date.now();
    const applied = await service.applyWal(actor.id);
    event("apply", { elapsedMs: Date.now() - start, result: applied });
    assert.equal(await service.repo.head(volume.id), 1);
    assert.ok(await service.confirmPersistence(actor.id, 1));
    const plan = await service.plan(actor);
    assert.equal(plan.entries.length, entries.length);
    assert.equal(Object.keys(plan.chunks).length, N);
    durable(
      join(root, "ack-v1.json"),
      JSON.stringify({
        seq: 1,
        bytes: meta.bytes,
        packedBytes: totalPacked,
        files: 4097,
        chunks: N,
        packs: 128,
      }),
    );
    fs.rmSync(join(root, "client"), { recursive: true });
    event("client-state-destroyed", { bytes: meta.bytes });
  } else if (mode === "restore") {
    await verify(
      1,
      JSON.parse(fs.readFileSync(join(root, "oracle-v1.json"), "utf8")),
      true,
    );
    assert.equal(await service.repo.head(meta.volumeId), 1);
  } else if (mode === "mutate") {
    const actor = await service.repo.getAttachment(meta.attachmentId);
    const before = JSON.parse(
      fs.readFileSync(join(root, "tree-v1.json"), "utf8"),
    );
    const big = before.find((e: any) => e.p === "big.bin");
    const replacement = Buffer.alloc(C, 0x5a);
    const id = chunkHash(replacement);
    const packed = zstdCompressSync(replacement);
    await service.issueSlots(actor);
    const key = service.packPrefix(actor) + "000128";
    await store.put(service.volumePrefix(meta.volumeId) + key, packed);
    big.c[0] = [id, C];
    big.t = "1";
    const orphanKey = service.packPrefix(actor) + "000129";
    const orphanChunks: any = {},
      orphanParts: Buffer[] = [];
    let orphanOffset = 0;
    const oc = createCipheriv(
      "aes-256-ctr",
      createHash("sha256")
        .update(meta.seed + "orphan")
        .digest(),
      Buffer.alloc(16),
    );
    for (let n = 0; n < 32; n++) {
      const raw = oc.update(Buffer.alloc(C)),
        packed = zstdCompressSync(raw);
      orphanChunks[chunkHash(raw)] = [
        orphanKey,
        orphanOffset,
        packed.length,
        C,
      ];
      orphanParts.push(packed);
      orphanOffset += packed.length;
    }
    await store.put(
      service.volumePrefix(meta.volumeId) + orphanKey,
      Buffer.concat(orphanParts),
    );
    const m = {
      v: 1,
      volume: meta.volumeId,
      attachment: actor.id,
      boot_id: "gb-boot",
      seq: 2,
      base: 1,
      upserts: [big],
      deletes: ["small/g0"],
      chunks: { [id]: [key, 0, packed.length, C], ...orphanChunks },
    };
    await store.put(
      service.volumePrefix(meta.volumeId) + service.manifestPrefix(actor) + "2",
      encodeManifestObject(m),
    );
    const result = await service.applyWal(actor.id);
    assert.equal(await service.repo.head(meta.volumeId), 2);
    assert.ok(await service.confirmPersistence(actor.id, 2));
    event("mutation-applied", { result });
    const ledger = JSON.parse(
      fs.readFileSync(join(root, "oracle-v1.json"), "utf8"),
    );
    for (let n = 0; n < 64; n++) delete ledger[`small/g0/f${n}.bin`];
    const c = cipher(),
      h = createHash("sha256");
    for (let i = 0; i < 4096; i++) {
      const raw = c.update(Buffer.alloc(C));
      h.update(i === 0 ? replacement : raw);
    }
    ledger["big.bin"] = { size: 1024 ** 3, sha256: h.digest("hex") };
    durable(join(root, "oracle-v2.json"), JSON.stringify(ledger));
    await verify(2, ledger, false);
    await verify(
      1,
      JSON.parse(fs.readFileSync(join(root, "oracle-v1.json"), "utf8")),
      false,
    );
    assert.equal(await service.rollback(meta.volumeId, 1), 3);
    const gc = await service.maintenance.collect(meta.volumeId, {
      dryRun: false,
    });
    assert.equal(gc.failures.length, 0);
    assert.deepEqual(gc.deleted, [orphanKey]);
    event("rollback-gc", { head: 3, gc });
    await verify(
      3,
      JSON.parse(fs.readFileSync(join(root, "oracle-v1.json"), "utf8")),
      true,
    );
    await verify(2, ledger, false);
  } else if (mode === "metadata") {
    const tree = JSON.parse(
      fs.readFileSync(join(root, "tree-v1.json"), "utf8"),
    );
    const sort = (a: any, b: any) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
    for (const seq of [1, 2, 3]) {
      const expected = tree
        .filter(
          (e: any) =>
            seq !== 2 || !(e.p === "small/g0" || e.p.startsWith("small/g0/")),
        )
        .map((e: any) => ({
          p: e.p,
          k: e.k,
          m: e.m,
          t: seq === 2 && e.p === "big.bin" ? "1" : e.t,
        }))
        .sort(sort);
      const rows = await service.repo.entriesAt(meta.volumeId, seq);
      assert.deepEqual(
        rows
          .map((e: any) => ({
            p: e.path,
            k: e.kind,
            m: e.mode,
            t: e.mtimeNs.toString(),
          }))
          .sort(sort),
        expected,
      );
      event("metadata-verified", { seq, entries: rows.length });
    }
    assert.equal(await service.repo.head(meta.volumeId), 3);
  } else throw Error("unknown mode");
  event("complete", { mode, resource: process.resourceUsage() });
} finally {
  await pool.end();
}
