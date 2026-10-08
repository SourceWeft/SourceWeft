import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { VolumeService } from "../../src/service/volume-service";
import {
  encodeManifestObject,
  parseManifestObject,
} from "../../src/protocol/manifest";
import type { Manifest } from "../../src/protocol/types";
import { cleanupE2EContext, createE2EContext, e2eEnabled } from "./env";
import { fetchAfterConnectRetry } from "../../../sandbox-provider-cloudflare/src/connect-retry";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function settleOperations<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "concurrent test operations failed after all operations settled",
    );
  return results.map((result) => {
    assert.equal(result.status, "fulfilled");
    return result.value;
  });
}
async function conditionalPut(url: string, bytes: Uint8Array) {
  const response = await fetchAfterConnectRetry(fetch, url, {
    method: "PUT",
    headers: { "If-None-Match": "*" },
    body: bytes as BodyInit,
    signal: AbortSignal.timeout(30_000),
  });
  await response.arrayBuffer();
  return response.status;
}

test(
  "real R2 contention, expired signatures and late old-writer uploads never change confirmed history",
  {
    skip: !e2eEnabled,
    timeout: 180_000,
  },
  async () => {
    const ctx = await createE2EContext();
    try {
      const volume = await ctx.service.getOrCreateVolume(ctx.scope);
      const actor = await ctx.service.attach(volume.id, "contention-fixture");
      await ctx.service.recordBootId(actor.id, "contention-boot");
      const slots = await ctx.service.issueSlots(actor);
      const data = Array.from({ length: 16 }, (_, i) => {
        const bytes = Buffer.alloc(256 * 1024);
        for (let offset = 0; offset < bytes.length; offset += 32)
          createHash("sha256")
            .update(`seed-5eed:${i}:${offset}`)
            .digest()
            .copy(bytes, offset);
        return bytes;
      });
      const packResults = await settleOperations(
        data.map((bytes) => conditionalPut(slots.packs["0"]!, bytes)),
      );
      assert.equal(packResults.filter((status) => status === 200).length, 1);
      assert.ok(
        packResults.every(
          (status) => status === 200 || status === 412 || status === 409,
        ),
      );
      const packKey = `${ctx.service.volumePrefix(volume.id)}${slots.pack_prefix}000000`;
      const winnerBytes = await ctx.store.get(packKey, {
        maxBytes: 256 * 1024,
      });
      assert.ok(winnerBytes);
      assert.equal(
        digest(winnerBytes),
        digest(data[packResults.indexOf(200)]!),
      );

      const candidates: Manifest[] = data.map((_bytes, i) => ({
        v: 1,
        volume: volume.id,
        attachment: actor.id,
        boot_id: "contention-boot",
        seq: 1,
        base: 0,
        upserts: [{ p: `winner-${i}`, k: "d", m: 493 }],
        deletes: [],
        chunks: {},
      }));
      const manifestResults = await settleOperations(
        candidates.map((manifest) =>
          conditionalPut(slots.manifests["1"]!, encodeManifestObject(manifest)),
        ),
      );
      assert.equal(
        manifestResults.filter((status) => status === 200).length,
        1,
      );
      assert.ok(
        manifestResults.every(
          (status) => status === 200 || status === 412 || status === 409,
        ),
      );
      const canonical = await ctx.store.get(
        `${ctx.service.volumePrefix(volume.id)}${slots.manifest_prefix}1`,
        { maxBytes: 4096 },
      );
      assert.ok(canonical);
      assert.deepEqual(
        parseManifestObject(canonical).manifest,
        candidates[manifestResults.indexOf(200)],
      );

      const appliers = Array.from(
        { length: 8 },
        () =>
          new VolumeService({
            db: drizzle(ctx.pool, { casing: "snake_case" }),
            store: ctx.store,
            keyPrefix: ctx.keyPrefix,
          }),
      );
      const applied = await settleOperations(
        appliers.map((service) => service.applyWal(actor.id)),
      );
      assert.equal(
        applied.reduce((sum, result) => sum + result.applied, 0),
        1,
      );
      assert.ok(applied.every((result) => result.rejected === null));
      assert.equal(await ctx.service.confirmPersistence(actor.id, 1), true);
      const expectedPath = `winner-${manifestResults.indexOf(200)}`;
      assert.deepEqual(
        (await ctx.service.repo.entries(volume.id)).map((entry) => entry.path),
        [expectedPath],
      );
      assert.equal(
        (
          await ctx.pool.query(
            "select count(*)::int n from sandbox_volume_commits where volume_id=$1",
            [volume.id],
          )
        ).rows[0].n,
        1,
      );

      const expiredGet = await ctx.store.presignGet(packKey, 1);
      const absentKey = `${ctx.keyPrefix}expiry-never-written`;
      const expiredPut = await ctx.store.presignWriteOnce(absentKey, 1);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const expired = await fetchAfterConnectRetry(fetch, expiredGet, {
        signal: AbortSignal.timeout(30_000),
      });
      await expired.arrayBuffer();
      assert.equal(expired.status, 403);
      assert.equal(await conditionalPut(expiredPut, data[0]!), 403);
      assert.equal(await ctx.store.get(absentKey), null);
      const fresh = await fetchAfterConnectRetry(
        fetch,
        await ctx.store.presignGet(packKey, 60),
        { signal: AbortSignal.timeout(30_000) },
      );
      assert.equal(fresh.status, 200);
      assert.equal(
        digest(new Uint8Array(await fresh.arrayBuffer())),
        digest(winnerBytes),
      );

      assert.equal(await ctx.service.rollback(volume.id, 0), 2);
      // Storage signatures remain valid until expiration; only the DB writer fence
      // can prevent a late old attachment from becoming the authoritative tree.
      const late: Manifest = {
        ...candidates[0]!,
        seq: 2,
        base: 1,
        upserts: [{ p: "late-writer", k: "d", m: 493 }],
      };
      assert.equal(
        await conditionalPut(slots.manifests["2"]!, encodeManifestObject(late)),
        200,
      );
      await assert.rejects(ctx.service.applyWal(actor.id), /not active/);
      assert.equal(await ctx.service.confirmPersistence(actor.id, 1), false);
      assert.equal(await ctx.service.repo.head(volume.id), 2);
      assert.deepEqual(await ctx.service.repo.entries(volume.id), []);
      assert.deepEqual(
        (await ctx.service.repo.entriesAt(volume.id, 1)).map(
          (entry) => entry.path,
        ),
        [expectedPath],
      );
      assert.equal(
        digest((await ctx.store.get(packKey))!),
        digest(winnerBytes),
      );
      console.log(
        JSON.stringify({
          seed: "5eed",
          objectContenders: 16,
          manifestContenders: 16,
          independentAppliers: 8,
          objectStatuses: packResults,
          manifestStatuses: manifestResults,
          historyVerified: true,
          expiredSignaturesRejected: true,
        }),
      );
    } finally {
      await cleanupE2EContext(ctx);
    }
  },
);
