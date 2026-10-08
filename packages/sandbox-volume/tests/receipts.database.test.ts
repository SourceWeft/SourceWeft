import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { VolumeRepository } from "../src/service/repository";
import { resolveVolumeLimits, VolumeQuotaExceeded } from "../src/service/quota";
import { VolumeService } from "../src/service/volume-service";
import { encodeManifestObject } from "../src/protocol/manifest";
import type { Manifest } from "../src/protocol/types";
import type { ObjectStore } from "../src/store/object-store";

// Explicit disposable database only. This suite never reads backend .env or production credentials.
const url = process.env.SANDBOX_VOLUME_TEST_DATABASE_URL;
const enabled = Boolean(url);
let pool: Pool;
let admin: Pool;
const testSchema = `receipt_${randomUUID().replaceAll("-", "")}`;
let repo: VolumeRepository;
let service: VolumeService;
before(async () => {
  if (!url) return;
  admin = new Pool({ connectionString: url });
  await admin.query(`create schema ${testSchema}`);
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${testSchema}`,
  });
  await pool.query(`create table workspaces(id text primary key);
    create table threads(id text primary key, workspace_id text not null, team_id text not null, unique(id,workspace_id,team_id));`);
  await pool.query(
    readFileSync(
      new URL("../../db/drizzle/0060_sandbox_volumes.sql", import.meta.url),
      "utf8",
    ).replaceAll('"public".', `"${testSchema}".`),
  );
  await pool.query(
    readFileSync(
      new URL(
        "../../db/drizzle/0061_sandbox_volume_integrity.sql",
        import.meta.url,
      ),
      "utf8",
    ).replaceAll('"public".', `"${testSchema}".`),
  );
  await pool.query(
    readFileSync(
      new URL("../../db/drizzle/0062_sandbox_volume_gc.sql", import.meta.url),
      "utf8",
    ).replaceAll('"public".', `"${testSchema}".`),
  );
  const db = drizzle(pool);
  repo = new VolumeRepository(db);
  service = new VolumeService({
    db,
    store: {
      presignWriteOnce: async () => {
        throw new Error("unexpected slot issuance");
      },
    } as unknown as ObjectStore,
    keyPrefix: "receipt-test/",
  });
});
after(async () => {
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`drop schema ${testSchema} cascade`);
    await admin.end();
  }
});
async function volume() {
  const id = randomUUID();
  await pool.query("insert into workspaces values($1)", [id]);
  await pool.query("insert into threads values($1,$1,$1)", [id]);
  return repo.getOrCreateVolume(id, {
    teamId: id,
    workspaceId: id,
    threadId: id,
  });
}
const manifest = (
  volume: string,
  attachment: string,
  base: number,
  path: string,
): Manifest => ({
  v: 1,
  volume,
  attachment,
  boot_id: "boot",
  seq: base + 1,
  base,
  full: false,
  trigger: "flush",
  upserts: [{ p: path, k: "d", m: 493, t: "0" }],
  deletes: [],
  chunks: {},
  packs: [],
  unstable: [],
  skipped: [],
  ts_ms: Date.now(),
});
test(
  "new attachment no-change receipt starts at locked volume head",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "A",
      baseSeq: 999,
    });
    assert.equal(a.baseSeq, 0);
    assert.equal(a.lastAppliedSeq, 0);
    assert.equal(await service.confirmPersistence(a.id, 0), true);
    assert.equal(await service.confirmPersistence(a.id, 1), false);
  },
);
test(
  "another attachment advancing global head cannot acknowledge A's skipped sequence",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "A",
      baseSeq: 0,
    });
    const b = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "B",
      baseSeq: 0,
    });
    await repo.applyManifest(v.id, manifest(v.id, b.id, 0, "B"), {}, new Map());
    assert.equal(await repo.head(v.id), 1);
    assert.equal(await service.confirmPersistence(a.id, 1), false);
    assert.equal(await service.confirmPersistence(b.id, 1), true);
    await assert.rejects(
      repo.applyManifest(v.id, manifest(v.id, a.id, 0, "A"), {}, new Map()),
      /active|superseded|head/i,
    );
    await assert.rejects(service.beginRebase(a.id), /active|superseded/i);
    await assert.rejects(service.applyWal(a.id), /active|superseded/i);
    assert.deepEqual(
      (await repo.entries(v.id)).map((x) => x.path),
      ["B"],
    );
  },
);
test(
  "receipt and entries advance atomically, stale base cannot overwrite",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "A",
      baseSeq: 0,
    });
    await repo.applyManifest(
      v.id,
      manifest(v.id, a.id, 0, "first"),
      {},
      new Map(),
    );
    assert.equal((await repo.getAttachment(a.id))?.lastAppliedSeq, 1);
    await assert.rejects(
      repo.applyManifest(v.id, manifest(v.id, a.id, 0, "stale"), {}, new Map()),
      /head|base/i,
    );
    assert.equal((await repo.getAttachment(a.id))?.lastAppliedSeq, 1);
    assert.deepEqual(
      (await repo.entries(v.id)).map((x) => x.path),
      ["first"],
    );
    const b = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "B",
      baseSeq: 0,
    });
    assert.equal(b.baseSeq, 1);
    assert.equal(b.lastAppliedSeq, 1);
    assert.equal(await service.confirmPersistence(a.id, 1), false);
    assert.equal(await service.confirmPersistence(b.id, 1), true);
  },
);
test(
  "two concurrent attaches have one active owner and locked base",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const actors = await Promise.all(
      ["A", "B"].map((sandboxId) =>
        repo.createAttachment({
          id: randomUUID(),
          volumeId: v.id,
          sandboxId,
          baseSeq: 99,
        }),
      ),
    );
    const rows = await pool.query(
      "select id, status, base_seq from sandbox_volume_attachments where volume_id=$1",
      [v.id],
    );
    assert.equal(rows.rows.filter((x) => x.status === "active").length, 1);
    for (const a of actors) assert.equal(a.baseSeq, 0);
    const active = rows.rows.find((x) => x.status === "active");
    for (const a of actors)
      assert.equal(
        await service.confirmPersistence(a.id, 0),
        a.id === active.id,
      );
  },
);
test(
  "concurrent commits from the same base have exactly one receipt winner",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "A",
      baseSeq: 0,
    });
    const results = await Promise.allSettled(
      ["first", "second"].map((path) =>
        repo.applyManifest(v.id, manifest(v.id, a.id, 0, path), {}, new Map()),
      ),
    );
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(await repo.head(v.id), 1);
    assert.equal((await repo.getAttachment(a.id))?.lastAppliedSeq, 1);
    assert.equal((await repo.entries(v.id)).length, 1);
  },
);

test(
  "failed entry mutation rolls back the entire commit and receipt",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "A",
      baseSeq: 0,
    });
    const m = manifest(v.id, a.id, 0, "first");
    m.upserts!.push({
      p: "invalid",
      k: "d",
      m: Number.POSITIVE_INFINITY,
      t: "0",
    });
    await assert.rejects(repo.applyManifest(v.id, m, {}, new Map()));
    assert.equal(await repo.head(v.id), 0);
    assert.equal((await repo.getAttachment(a.id))?.lastAppliedSeq, 0);
    assert.deepEqual(await repo.entries(v.id), []);
    assert.equal(await service.confirmPersistence(a.id, 1), false);
  },
);

test(
  "cross-volume actor and invalid receipt sequence cannot confirm",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const other = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "A",
      baseSeq: 0,
    });
    await assert.rejects(
      repo.applyManifest(
        other.id,
        manifest(other.id, a.id, 0, "wrong"),
        {},
        new Map(),
      ),
      /active|superseded/i,
    );
    assert.equal(await service.confirmPersistence(a.id, Number.NaN), false);
    assert.equal(await service.confirmPersistence(a.id, -1), false);
    assert.equal(
      await service.confirmPersistence(a.id, Number.MAX_SAFE_INTEGER + 1),
      false,
    );
  },
);

test(
  "rollback revokes old actor receipt and prevents old tree rebase",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "A",
      baseSeq: 0,
    });
    await repo.applyManifest(
      v.id,
      manifest(v.id, a.id, 0, "before-delete"),
      {},
      new Map(),
    );
    const deleted = manifest(v.id, a.id, 1, "after-delete");
    deleted.deletes = ["before-delete"];
    await repo.applyManifest(v.id, deleted, {}, new Map());
    assert.equal(await service.confirmPersistence(a.id, 2), true);
    const rolledBack = await repo.rollback(v.id, 1);
    assert.equal(rolledBack, 3);
    assert.equal(await service.confirmPersistence(a.id, 2), false);
    await assert.rejects(service.beginRebase(a.id), /active|superseded/i);
    await assert.rejects(
      repo.applyManifest(
        v.id,
        manifest(v.id, a.id, 3, "old-tree"),
        {},
        new Map(),
      ),
      /active|superseded/i,
    );
    assert.deepEqual(
      (await repo.entries(v.id)).map((x) => x.path),
      ["before-delete"],
    );
    const b = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "B",
      baseSeq: 2,
    });
    assert.equal(b.baseSeq, 3);
    assert.equal(b.lastAppliedSeq, 3);
    assert.equal(await service.confirmPersistence(b.id, 3), true);
  },
);

test(
  "atomic reservations allocate distinct packs and re-sign the outstanding manifest window",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "slots",
      baseSeq: 0,
    });
    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => repo.reserveSlots(a, 64, 64, 3600)),
    );
    assert.deepEqual(
      reservations.map((x) => x.firstPack).sort((a, b) => a - b),
      [0, 64, 128, 192, 256, 320, 384, 448],
    );
    assert.ok(reservations.every((x) => x.firstSeq === 1 && x.lastSeq === 64));
    const fresh = await repo.advanceAttachmentEpoch(a.id);
    await assert.rejects(repo.reserveSlots(a, 64, 64, 3600), /epoch changed/);
    assert.equal(fresh.slotsUntilSeq, 0);
  },
);

test(
  "boot identity binds once and transaction fencing rejects old epoch",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "boot",
      baseSeq: 0,
    });
    await service.recordBootId(a.id, "boot");
    await service.recordBootId(a.id, "boot");
    await assert.rejects(
      service.recordBootId(a.id, "other"),
      /boot identity changed/,
    );
    await repo.reserveSlots(a, 64, 64, 3600);
    const identity = {
      epoch: 0,
      manifestKey: `att/${a.id}/m/0/1`,
      manifestHash: "a".repeat(64),
    };
    const wrongBoot = { ...manifest(v.id, a.id, 0, "boot"), boot_id: "wrong" };
    await assert.rejects(
      repo.applyManifest(v.id, wrongBoot, {}, new Map(), identity),
      /boot identity/,
    );
    await repo.advanceAttachmentEpoch(a.id);
    await assert.rejects(
      repo.applyManifest(
        v.id,
        manifest(v.id, a.id, 0, "epoch"),
        {},
        new Map(),
        identity,
      ),
      /epoch changed/,
    );
    assert.equal(await repo.head(v.id), 0);
  },
);

test(
  "same manifest is idempotent across independent host services; infrastructure errors are retryable",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "host",
      baseSeq: 0,
    });
    await repo.reserveSlots(a, 64, 64, 3600);
    const raw = encodeManifestObject(manifest(v.id, a.id, 0, "committed"));
    let failing = true;
    const store = {
      get: async (key: string) => {
        if (failing) throw new Error("S3 temporarily unavailable");
        return key.endsWith("/m/0/1") ? raw : null;
      },
    } as unknown as ObjectStore;
    const hosts = [
      new VolumeService({ db: drizzle(pool), store, keyPrefix: "test/" }),
      new VolumeService({ db: drizzle(pool), store, keyPrefix: "test/" }),
    ];
    await assert.rejects(hosts[0]!.applyWal(a.id), /temporarily unavailable/);
    assert.equal(await repo.rejectCount(v.id), 0);
    failing = false;
    await Promise.all(hosts.map((host) => host.applyWal(a.id)));
    assert.equal(await repo.head(v.id), 1);
    assert.equal(await repo.rejectCount(v.id), 0);
    const receipt = await pool.query(
      "select * from sandbox_volume_commits where volume_id=$1",
      [v.id],
    );
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0].attachment_id, a.id);
    assert.equal(await service.confirmPersistence(a.id, 1), true);
  },
);

test(
  "quarantine persists across services, fences WAL and prevents replacement",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "cancel",
      baseSeq: 0,
    });
    await service.quarantineAttachment(a.id, "cancel outcome unknown");
    await service.quarantineAttachment(a.id, "cancel outcome unknown");
    assert.equal(
      (await repo.getAttachment(a.id))?.quarantineReason,
      "cancel outcome unknown",
    );
    await assert.rejects(service.assertAttachmentActive(a.id), /not active/);
    await assert.rejects(service.attach(v.id, "replacement"), /quarantined/);
    await assert.rejects(service.applyWal(a.id), /not active/);
    assert.equal(await service.confirmPersistence(a.id, 0), false);
  },
);

test(
  "namespace isolates shadow observations from the primary thread volume",
  { skip: !enabled },
  async () => {
    const primary = await volume();
    const scope = {
      teamId: primary.teamId,
      workspaceId: primary.workspaceId,
      threadId: primary.threadId,
    };
    const shadow = await repo.getOrCreateVolume(randomUUID(), {
      ...scope,
      namespace: "shadow:one",
    });
    assert.notEqual(primary.id, shadow.id);
    assert.equal((await repo.findVolume(scope))?.id, primary.id);
    assert.equal(
      (await repo.findVolume({ ...scope, namespace: "shadow:one" }))?.id,
      shadow.id,
    );
  },
);

test(
  "restore snapshot keeps head and entries consistent during concurrent commits",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "snapshot",
      baseSeq: 0,
    });
    const writer = (async () => {
      for (let base = 0; base < 20; base++)
        await repo.applyManifest(
          v.id,
          { ...manifest(v.id, a.id, base, `seq-${base + 1}`), full: true },
          {},
          new Map(),
        );
    })();
    for (let n = 0; n < 30; n++) {
      const plan = await repo.planSnapshot(v.id);
      assert.deepEqual(
        plan.entries.map((x) => x.p),
        plan.seq === 0 ? [] : [`seq-${plan.seq}`],
      );
    }
    await writer;
    assert.equal(await repo.head(v.id), 20);
    await assert.rejects(repo.rollback(v.id, 21), /beyond current head/);
    assert.equal(await service.confirmPersistence(a.id, 20), true);
  },
);

test(
  "restore snapshot resolves recorded bytea chunk locations",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "chunk",
      baseSeq: 0,
    });
    const chunk = "a".repeat(64),
      pack = `att/${a.id}/p/000000`;
    const m = {
      ...manifest(v.id, a.id, 0, "file"),
      upserts: [
        {
          p: "file",
          k: "f" as const,
          m: 420,
          s: 5,
          c: [[chunk, 5] as [string, number]],
        },
      ],
    };
    await repo.applyManifest(
      v.id,
      m,
      { [chunk]: [pack, 0, 5, 5] },
      new Map([[pack, 5]]),
    );
    const plan = await repo.planSnapshot(v.id);
    assert.deepEqual(plan.chunks[chunk], [pack, 0, 5, 5]);
  },
);

test(
  "delta cannot install a child below an existing file or missing parent",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await repo.createAttachment({
      id: randomUUID(),
      volumeId: v.id,
      sandboxId: "parent",
      baseSeq: 0,
    });
    await repo.applyManifest(
      v.id,
      {
        ...manifest(v.id, a.id, 0, "file"),
        upserts: [{ p: "file", k: "f", m: 420, s: 0, c: [] }],
      },
      {},
      new Map(),
    );
    for (const path of ["file/child", "missing/child"])
      await assert.rejects(
        repo.applyManifest(v.id, manifest(v.id, a.id, 1, path), {}, new Map()),
        /parent/,
      );
    assert.equal(await repo.head(v.id), 1);
    assert.deepEqual(
      (await repo.entries(v.id)).map((e) => e.path),
      ["file"],
    );
  },
);

test(
  "repair refuses undeclared keys before performing an object copy",
  { skip: !enabled },
  async () => {
    const v = await volume();
    let copies = 0;
    const repair = new VolumeService({
      db: drizzle(pool),
      keyPrefix: "test/",
      store: {
        copy: async () => {
          copies++;
        },
      } as unknown as ObjectStore,
    });
    await assert.rejects(
      repair.repairPack(v.id, "../../other-volume/private"),
      /not registered/,
    );
    assert.equal(copies, 0);
  },
);

test(
  "ordinary attach cannot take over an active writer; explicit replacement uses CAS",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "first");
    await assert.rejects(
      service.attach(v.id, "second"),
      /already has an active/,
    );
    await assert.rejects(
      service.attach(v.id, "second", { expectedAttachmentId: "stale" }),
      /active|changed/,
    );
    const recovery = new VolumeService({
      db: drizzle(pool),
      keyPrefix: "test/",
      store: { get: async () => null } as unknown as ObjectStore,
    });
    const b = await recovery.attach(v.id, "second", {
      expectedAttachmentId: a.id,
    });
    assert.notEqual(a.id, b.id);
    await assert.rejects(
      repo.createAttachment({
        id: randomUUID(),
        volumeId: v.id,
        sandboxId: "third",
        baseSeq: 0,
        expectedAttachmentId: a.id,
      }),
      /changed/,
    );
  },
);

test(
  "slot signing failure retries include all unconfirmed pack slots",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "slots-retry");
    let failing = true;
    const slotsService = new VolumeService({
      db: drizzle(pool),
      keyPrefix: "test/",
      store: {
        presignWriteOnce: async (key: string) => {
          if (failing && key.endsWith("/p/000003"))
            throw new Error("signer unavailable");
          return key;
        },
      } as unknown as ObjectStore,
    });
    await assert.rejects(slotsService.issueSlots(a), /signer unavailable/);
    failing = false;
    const retried = await slotsService.issueSlots(a);
    assert.ok(retried.packs["0"]);
    assert.ok(retried.packs["127"]);
    assert.ok(retried.manifests["1"]);
    const chunk = "a".repeat(64),
      pack = `att/${a.id}/p/000070`;
    await repo.applyManifest(
      v.id,
      manifest(v.id, a.id, 0, "recorded"),
      { [chunk]: [pack, 0, 5, 5] },
      new Map([[pack, 5]]),
    );
    const next = await slotsService.issueSlots(a);
    assert.equal(next.packs["70"], undefined);
    assert.ok(next.packs["71"]);
    assert.ok(next.packs["191"]);
  },
);

test(
  "independent Node processes apply one WAL manifest exactly once",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "processes");
    await repo.reserveSlots(a, 64, 64, 3600);
    const worker = fileURLToPath(
      new URL("./fixtures/wal-process.ts", import.meta.url),
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          worker,
          url!,
          testSchema,
          v.id,
          a.id,
        ]),
      ),
    );
    assert.equal(
      results.reduce((sum, r) => sum + JSON.parse(r.stdout).applied, 0),
      1,
    );
    assert.equal(await repo.head(v.id), 1);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from sandbox_volume_commits where volume_id=$1",
          [v.id],
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  "0061 upgrades populated 0060 without inventing historical receipts",
  { skip: !enabled },
  async () => {
    const schema = `migration_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create schema ${schema}`);
    const legacy = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    try {
      await legacy.query(
        "create table workspaces(id text primary key); create table threads(id text primary key,workspace_id text not null,team_id text not null,unique(id,workspace_id,team_id));",
      );
      await legacy.query(
        readFileSync(
          new URL("../../db/drizzle/0060_sandbox_volumes.sql", import.meta.url),
          "utf8",
        ).replaceAll('"public".', `"${schema}".`),
      );
      await legacy.query(
        "insert into workspaces values('w'); insert into threads values('t','w','team'); insert into sandbox_volumes(id,team_id,workspace_id,thread_id,head_seq) values('v','team','w','t',7); insert into sandbox_volume_attachments(id,volume_id,base_seq) values('a','v',5);",
      );
      await legacy.query(
        readFileSync(
          new URL(
            "../../db/drizzle/0061_sandbox_volume_integrity.sql",
            import.meta.url,
          ),
          "utf8",
        ).replaceAll('"public".', `"${schema}".`),
      );
      const migrated = new VolumeRepository(drizzle(legacy));
      assert.equal((await migrated.getAttachment("a"))?.lastAppliedSeq, 5);
      assert.equal((await migrated.getVolume("v"))?.namespace, "primary");
      assert.equal(await migrated.confirmPersistence("a", 5), true);
      assert.equal(await migrated.confirmPersistence("a", 7), false);
      assert.equal(
        (
          await legacy.query(
            "select count(*)::int n from sandbox_volume_commits",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await legacy.end();
      await admin.query(`drop schema ${schema} cascade`);
    }
  },
);

test(
  "transactional logical/file/entry/object quotas reject without changing head or receipt",
  { skip: !enabled },
  async () => {
    for (const dimension of [
      "maxLogicalBytes",
      "maxFileBytes",
      "maxEntries",
      "maxObjectBytes",
    ] as const) {
      const v = await volume();
      const a = await service.attach(v.id, "quota");
      const quota = new VolumeRepository(
        drizzle(pool),
        resolveVolumeLimits({
          [dimension]: dimension === "maxEntries" ? 0 : 4,
        }),
      );
      const chunk = "a".repeat(64),
        key = `att/${a.id}/p/000000`;
      const m = {
        ...manifest(v.id, a.id, 0, "file"),
        upserts: [
          {
            p: "file",
            k: "f" as const,
            m: 420,
            s: 5,
            c: [[chunk, 5] as [string, number]],
          },
        ],
      };
      await assert.rejects(
        quota.applyManifest(
          v.id,
          m,
          { [chunk]: [key, 0, 5, 5] },
          new Map([[key, 5]]),
        ),
        (e) => e instanceof VolumeQuotaExceeded && e.resource === dimension,
      );
      assert.equal(await repo.head(v.id), 0);
      assert.equal((await repo.getAttachment(a.id))?.lastAppliedSeq, 0);
      assert.deepEqual(await repo.entries(v.id), []);
      assert.equal(await repo.registeredPackSize(v.id, key), null);
    }
  },
);

test(
  "GC dry run, grace, current/history/inline pins, active pin and retryable individual deletion",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "gc");
    const used = "a".repeat(64),
      orphan = "b".repeat(64),
      inline = "c".repeat(64);
    const usedKey = `att/${a.id}/p/000000`,
      orphanKey = `att/${a.id}/p/000001`,
      inlineKey = `att/${a.id}/m/0/1`;
    await repo.reserveSlots(a, 64, 64, 3600);
    const m = {
      ...manifest(v.id, a.id, 0, "file"),
      upserts: [
        {
          p: "file",
          k: "f" as const,
          m: 420,
          s: 5,
          c: [[used, 5] as [string, number]],
        },
      ],
    };
    await repo.applyManifest(
      v.id,
      m,
      {
        [used]: [usedKey, 0, 5, 5],
        [orphan]: [orphanKey, 0, 5, 5],
        [inline]: [inlineKey, 16, 5, 5],
      },
      new Map([
        [usedKey, 5],
        [orphanKey, 5],
        [inlineKey, 21],
      ]),
      { epoch: 0, manifestKey: inlineKey, manifestHash: "d".repeat(64) },
    );
    let fail = true;
    const deleted: string[] = [];
    const gc = new VolumeService({
      db: drizzle(pool),
      keyPrefix: "gc/",
      gcGraceMs: 3600000,
      store: {
        deleteObject: async (key: string) => {
          if (fail) throw new Error("S3 timeout");
          deleted.push(key);
        },
      } as unknown as ObjectStore,
    });
    assert.equal((await gc.maintenance.collect(v.id)).pinned, true);
    await repo.rollback(v.id, 0); // Current tree is empty; retained historical file still pins usedKey.
    const dry = await gc.maintenance.collect(v.id);
    assert.deepEqual(dry.candidates, [orphanKey]);
    assert.deepEqual(deleted, []);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from sandbox_volume_gc_candidates where volume_id=$1",
          [v.id],
        )
      ).rows[0].n,
      0,
    );
    const pending = await gc.maintenance.collect(v.id, { dryRun: false });
    assert.deepEqual(pending.deleted, []);
    await pool.query(
      "update sandbox_volume_gc_candidates set not_before=now()-interval '1 second' where volume_id=$1",
      [v.id],
    );
    const failed = await gc.maintenance.collect(v.id, { dryRun: false });
    assert.deepEqual(failed.failures, [orphanKey]);
    assert.equal(await repo.chunkLength(v.id, orphan), null);
    assert.equal(await repo.registeredPackSize(v.id, orphanKey), null);
    fail = false;
    const retried = await gc.maintenance.collect(v.id, { dryRun: false });
    assert.deepEqual(retried.deleted, [orphanKey]);
    assert.deepEqual(deleted, [`gc/vol/${v.id}/${orphanKey}`]);
    assert.equal(await repo.registeredPackSize(v.id, usedKey), 5);
    assert.equal(await repo.registeredPackSize(v.id, inlineKey), 21);
    assert.deepEqual((await repo.entriesAt(v.id, 1))[0]?.chunks, [[used, 5]]);
  },
);

test(
  "GC second check honors a new active attachment before deleting an old candidate",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "old");
    const chunk = "a".repeat(64),
      key = `att/${a.id}/p/000000`;
    await repo.applyManifest(
      v.id,
      manifest(v.id, a.id, 0, "dir"),
      { [chunk]: [key, 0, 5, 5] },
      new Map([[key, 5]]),
    );
    await repo.rollback(v.id, 0);
    let deletes = 0;
    const gc = new VolumeService({
      db: drizzle(pool),
      keyPrefix: "gc/",
      gcGraceMs: 3600000,
      store: {
        deleteObject: async () => {
          deletes++;
        },
      } as unknown as ObjectStore,
    });
    await gc.maintenance.collect(v.id, { dryRun: false });
    await pool.query(
      "update sandbox_volume_gc_candidates set not_before=now()-interval '1 second' where volume_id=$1",
      [v.id],
    );
    const b = await service.attach(v.id, "new");
    assert.equal(
      (await gc.maintenance.collect(v.id, { dryRun: false })).pinned,
      true,
    );
    assert.equal(deletes, 0);
    await service.quarantineAttachment(b.id, "unknown");
    assert.equal(
      (await gc.maintenance.collect(v.id, { dryRun: false })).pinned,
      true,
    );
  },
);

test(
  "replacement refuses a rejected old WAL instead of silently dropping its chain",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "rejected");
    await repo.reserveSlots(a, 64, 64, 3600);
    const recovery = new VolumeService({
      db: drizzle(pool),
      keyPrefix: "test/",
      store: {
        get: async () =>
          encodeManifestObject({ ...manifest(v.id, a.id, 0, "bad"), v: 99 }),
      } as unknown as ObjectStore,
    });
    await assert.rejects(
      recovery.attach(v.id, "new", { expectedAttachmentId: a.id }),
      /WAL rejected.*recovery required/,
    );
    assert.equal((await repo.activeAttachment(v.id))?.id, a.id);
    assert.equal(await repo.head(v.id), 0);
  },
);

test(
  "rollback also enforces quotas and a denied rollback preserves active writer",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "rollback-quota");
    await repo.applyManifest(
      v.id,
      manifest(v.id, a.id, 0, "old"),
      {},
      new Map(),
    );
    await repo.applyManifest(
      v.id,
      { ...manifest(v.id, a.id, 1, "ignored"), upserts: [], deletes: ["old"] },
      {},
      new Map(),
    );
    const limited = new VolumeRepository(
      drizzle(pool),
      resolveVolumeLimits({ maxEntries: 0 }),
    );
    await assert.rejects(limited.rollback(v.id, 1), VolumeQuotaExceeded);
    assert.equal(await repo.head(v.id), 2);
    assert.equal((await repo.activeAttachment(v.id))?.id, a.id);
    assert.deepEqual(await repo.entries(v.id), []);
  },
);

test(
  "candidate re-referenced before deletion is retained after writer retires",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "candidate");
    const chunk = "a".repeat(64),
      key = `att/${a.id}/p/000000`;
    await repo.applyManifest(
      v.id,
      manifest(v.id, a.id, 0, "dir"),
      { [chunk]: [key, 0, 5, 5] },
      new Map([[key, 5]]),
    );
    await repo.rollback(v.id, 0);
    let deletions = 0;
    const gc = new VolumeService({
      db: drizzle(pool),
      keyPrefix: "gc/",
      gcGraceMs: 3600000,
      store: {
        deleteObject: async () => {
          deletions++;
        },
      } as unknown as ObjectStore,
    });
    await gc.maintenance.collect(v.id, { dryRun: false });
    await pool.query(
      "update sandbox_volume_gc_candidates set not_before=now()-interval '1 second' where volume_id=$1",
      [v.id],
    );
    const b = await service.attach(v.id, "referencing");
    await repo.applyManifest(
      v.id,
      {
        ...manifest(v.id, b.id, 2, "file"),
        upserts: [{ p: "file", k: "f", m: 420, s: 5, c: [[chunk, 5]] }],
      },
      {},
      new Map(),
    );
    await repo.rollback(v.id, 3);
    assert.equal(
      (await gc.maintenance.collect(v.id, { dryRun: false })).pinned,
      false,
    );
    assert.equal(deletions, 0);
    assert.equal(await repo.registeredPackSize(v.id, key), 5);
  },
);

test(
  "background WAL budget stops an endless producer, resumes, and frontend default drains",
  { skip: !enabled },
  async () => {
    const v = await volume();
    const a = await service.attach(v.id, "budget");
    await repo.reserveSlots(a, 64, 64, 3600);
    const requested: number[] = [];
    let end = Number.POSITIVE_INFINITY;
    const bounded = new VolumeService({
      db: drizzle(pool),
      keyPrefix: "budget/",
      store: {
        get: async (key: string) => {
          const seq = Number(key.split("/").at(-1));
          requested.push(seq);
          return seq > end
            ? null
            : encodeManifestObject(manifest(v.id, a.id, seq - 1, `seq-${seq}`));
        },
      } as unknown as ObjectStore,
    });
    const first = await bounded.applyWal(a.id, { maxCommits: 3 });
    assert.equal(first.applied, 3);
    assert.equal(first.hasMore, true);
    assert.deepEqual(requested, [1, 2, 3]);
    const next = await bounded.applyWal(a.id, { maxCommits: 2 });
    assert.equal(next.applied, 2);
    assert.equal(next.hasMore, true);
    assert.deepEqual(requested, [1, 2, 3, 4, 5]);
    end = 8;
    const foreground = await bounded.applyWal(a.id);
    assert.equal(foreground.applied, 3);
    assert.equal(foreground.hasMore, false);
    assert.equal(requested.at(-1), 9);
    assert.equal(await repo.head(v.id), 8);
    await assert.rejects(
      bounded.applyWal(a.id, { maxCommits: 0 }),
      /positive safe integer/,
    );
  },
);
