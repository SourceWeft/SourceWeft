import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  sandboxVolumeAttachments,
  sandboxVolumeChunks,
  sandboxVolumeEntries,
  sandboxVolumeEntryVersions,
  sandboxVolumePacks,
  sandboxVolumeRejects,
  sandboxVolumes,
} from "@sourceweft/db/schema";
import { descendantRange } from "../protocol/paths";
import type { ChunkLocation, EntryKind, Manifest, PlanEntry } from "../protocol/types";

/** Any drizzle node-postgres handle; the schema generic is not needed for the explicit queries used here. */
export type VolumeDatabase = NodePgDatabase<Record<string, unknown>>;
type Tx = Parameters<Parameters<VolumeDatabase["transaction"]>[0]>[0];

export type VolumeScope = { teamId: string; workspaceId: string; threadId: string };

export type VolumeRow = typeof sandboxVolumes.$inferSelect;
export type AttachmentRow = typeof sandboxVolumeAttachments.$inferSelect;
export type EntryRow = {
  path: string;
  kind: EntryKind;
  mode: number;
  mtimeNs: bigint;
  sizeBytes: number;
  linkTarget: string | null;
  chunks: Array<[string, number]>;
};

function chunkIdBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

export class VolumeRepository {
  constructor(private readonly db: VolumeDatabase) {}

  async getOrCreateVolume(id: string, scope: VolumeScope): Promise<VolumeRow> {
    const existing = await this.db
      .select()
      .from(sandboxVolumes)
      .where(and(eq(sandboxVolumes.teamId, scope.teamId), eq(sandboxVolumes.workspaceId, scope.workspaceId), eq(sandboxVolumes.threadId, scope.threadId)))
      .limit(1);
    if (existing[0]) return existing[0];
    await this.db.insert(sandboxVolumes).values({ id, ...scope }).onConflictDoNothing();
    const created = await this.db
      .select()
      .from(sandboxVolumes)
      .where(and(eq(sandboxVolumes.teamId, scope.teamId), eq(sandboxVolumes.workspaceId, scope.workspaceId), eq(sandboxVolumes.threadId, scope.threadId)))
      .limit(1);
    return created[0]!;
  }

  async getVolume(id: string): Promise<VolumeRow | null> {
    const rows = await this.db.select().from(sandboxVolumes).where(eq(sandboxVolumes.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async head(volumeId: string): Promise<number> {
    const rows = await this.db.select({ head: sandboxVolumes.headSeq }).from(sandboxVolumes).where(eq(sandboxVolumes.id, volumeId)).limit(1);
    if (!rows[0]) throw new Error(`volume ${volumeId} does not exist`);
    return rows[0].head;
  }

  async activeAttachment(volumeId: string): Promise<AttachmentRow | null> {
    const rows = await this.db
      .select()
      .from(sandboxVolumeAttachments)
      .where(and(eq(sandboxVolumeAttachments.volumeId, volumeId), eq(sandboxVolumeAttachments.status, "active")))
      .orderBy(sql`${sandboxVolumeAttachments.createdAt} desc`)
      .limit(1);
    return rows[0] ?? null;
  }

  async getAttachment(id: string): Promise<AttachmentRow | null> {
    const rows = await this.db.select().from(sandboxVolumeAttachments).where(eq(sandboxVolumeAttachments.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async createAttachment(input: { id: string; volumeId: string; sandboxId: string | null; baseSeq: number; bootId?: string | null }): Promise<AttachmentRow> {
    await this.db
      .update(sandboxVolumeAttachments)
      .set({ status: "superseded" })
      .where(and(eq(sandboxVolumeAttachments.volumeId, input.volumeId), eq(sandboxVolumeAttachments.status, "active")));
    const rows = await this.db
      .insert(sandboxVolumeAttachments)
      .values({ id: input.id, volumeId: input.volumeId, sandboxId: input.sandboxId, baseSeq: input.baseSeq, bootId: input.bootId ?? null })
      .returning();
    return rows[0]!;
  }

  async updateAttachment(id: string, patch: Partial<Pick<AttachmentRow, "epoch" | "status" | "bootId" | "slotsUntilPack" | "slotsUntilSeq" | "slotsExpireAt">>): Promise<void> {
    await this.db.update(sandboxVolumeAttachments).set(patch).where(eq(sandboxVolumeAttachments.id, id));
  }

  async chunkKnown(volumeId: string, chunkId: string): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(sandboxVolumeChunks)
      .where(and(eq(sandboxVolumeChunks.volumeId, volumeId), eq(sandboxVolumeChunks.chunkId, chunkIdBytes(chunkId))))
      .limit(1);
    return rows.length > 0;
  }

  async recordReject(input: { id: string; volumeId: string; attachmentId: string; seq: number; reason: string }): Promise<void> {
    await this.db.insert(sandboxVolumeRejects).values(input);
  }

  async rejectCount(volumeId: string): Promise<number> {
    const rows = await this.db.select({ n: sql<number>`count(*)::int` }).from(sandboxVolumeRejects).where(eq(sandboxVolumeRejects.volumeId, volumeId));
    return rows[0]?.n ?? 0;
  }

  async entries(volumeId: string): Promise<EntryRow[]> {
    const rows = await this.db
      .select({
        path: sandboxVolumeEntries.path,
        kind: sandboxVolumeEntries.kind,
        mode: sandboxVolumeEntries.mode,
        mtimeNs: sandboxVolumeEntries.mtimeNs,
        sizeBytes: sandboxVolumeEntries.sizeBytes,
        linkTarget: sandboxVolumeEntries.linkTarget,
        chunks: sandboxVolumeEntries.chunks,
      })
      .from(sandboxVolumeEntries)
      .where(eq(sandboxVolumeEntries.volumeId, volumeId))
      .orderBy(asc(sandboxVolumeEntries.path));
    return rows;
  }

  /** The tree as it was at `seq`, built from current entries and retained versions. */
  async entriesAt(volumeId: string, seq: number): Promise<EntryRow[]> {
    const current = await this.db
      .select({
        path: sandboxVolumeEntries.path,
        kind: sandboxVolumeEntries.kind,
        mode: sandboxVolumeEntries.mode,
        mtimeNs: sandboxVolumeEntries.mtimeNs,
        sizeBytes: sandboxVolumeEntries.sizeBytes,
        linkTarget: sandboxVolumeEntries.linkTarget,
        chunks: sandboxVolumeEntries.chunks,
      })
      .from(sandboxVolumeEntries)
      .where(and(eq(sandboxVolumeEntries.volumeId, volumeId), lte(sandboxVolumeEntries.seq, seq)));
    const old = await this.db
      .select({
        path: sandboxVolumeEntryVersions.path,
        kind: sandboxVolumeEntryVersions.kind,
        mode: sandboxVolumeEntryVersions.mode,
        mtimeNs: sandboxVolumeEntryVersions.mtimeNs,
        sizeBytes: sandboxVolumeEntryVersions.sizeBytes,
        linkTarget: sandboxVolumeEntryVersions.linkTarget,
        chunks: sandboxVolumeEntryVersions.chunks,
      })
      .from(sandboxVolumeEntryVersions)
      .where(and(eq(sandboxVolumeEntryVersions.volumeId, volumeId), lte(sandboxVolumeEntryVersions.fromSeq, seq), gt(sandboxVolumeEntryVersions.toSeq, seq)));
    return [...current, ...old].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async chunkLocations(volumeId: string, ids: Iterable<string>): Promise<Record<string, ChunkLocation>> {
    const wanted = [...new Set(ids)];
    const out: Record<string, ChunkLocation> = {};
    for (let i = 0; i < wanted.length; i += 5000) {
      const batch = wanted.slice(i, i + 5000).map(chunkIdBytes);
      if (batch.length === 0) continue;
      const rows = await this.db
        .select({
          id: sandboxVolumeChunks.chunkId,
          pack: sandboxVolumeChunks.packKey,
          off: sandboxVolumeChunks.off,
          clen: sandboxVolumeChunks.compressedLength,
          rlen: sandboxVolumeChunks.rawLength,
        })
        .from(sandboxVolumeChunks)
        .where(and(eq(sandboxVolumeChunks.volumeId, volumeId), sql`${sandboxVolumeChunks.chunkId} = any(${sql.param(batch, sandboxVolumeChunks.chunkId)}::bytea[])`));
      for (const row of rows) out[Buffer.from(row.id).toString("hex")] = [row.pack, row.off, row.clen, row.rlen];
    }
    return out;
  }

  /** Apply one validated manifest in a single transaction and advance the head. */
  async applyManifest(volumeId: string, manifest: Manifest, newChunks: Record<string, ChunkLocation>, packSizes: Map<string, number>): Promise<void> {
    const seq = manifest.seq;
    await this.db.transaction(async (tx) => {
      const keepVersion = async (where: ReturnType<typeof sql>) => {
        await tx.execute(sql`
          insert into sandbox_volume_entry_versions (volume_id, path, kind, mode, mtime_ns, size_bytes, link_target, chunks, from_seq, to_seq)
          select volume_id, path, kind, mode, mtime_ns, size_bytes, link_target, chunks, seq, ${seq}
          from sandbox_volume_entries where volume_id = ${volumeId} and ${where}`);
      };
      const dropChildren = async (path: string) => {
        const { from, to } = descendantRange(path);
        const under = sql`path > ${from} and path < ${to}`;
        await keepVersion(under);
        await tx.execute(sql`delete from sandbox_volume_entries where volume_id = ${volumeId} and ${under}`);
      };
      if (manifest.full) {
        const keep = new Set((manifest.upserts ?? []).map((e) => e.p));
        const paths = await tx.select({ path: sandboxVolumeEntries.path }).from(sandboxVolumeEntries).where(eq(sandboxVolumeEntries.volumeId, volumeId));
        for (const { path } of paths) {
          if (!keep.has(path)) {
            await keepVersion(sql`path = ${path}`);
            await tx.execute(sql`delete from sandbox_volume_entries where volume_id = ${volumeId} and path = ${path}`);
          }
        }
      }
      for (const path of manifest.deletes ?? []) {
        await keepVersion(sql`path = ${path}`);
        await tx.execute(sql`delete from sandbox_volume_entries where volume_id = ${volumeId} and path = ${path}`);
        await dropChildren(path);
      }
      for (const entry of manifest.upserts ?? []) {
        const old = await tx
          .select({ kind: sandboxVolumeEntries.kind, mode: sandboxVolumeEntries.mode, mtimeNs: sandboxVolumeEntries.mtimeNs, sizeBytes: sandboxVolumeEntries.sizeBytes, linkTarget: sandboxVolumeEntries.linkTarget, chunks: sandboxVolumeEntries.chunks })
          .from(sandboxVolumeEntries)
          .where(and(eq(sandboxVolumeEntries.volumeId, volumeId), eq(sandboxVolumeEntries.path, entry.p)))
          .limit(1);
        const previous = old[0];
        if (previous && previous.kind === "d" && entry.k !== "d") await dropChildren(entry.p); // a directory replaced by a file or link loses its children
        const next = { kind: entry.k, mode: entry.m, mtimeNs: BigInt(entry.t ?? "0"), sizeBytes: entry.s ?? 0, linkTarget: entry.l ?? null, chunks: entry.c ?? [] };
        if (previous && previous.kind === next.kind && previous.mode === next.mode && previous.mtimeNs === next.mtimeNs && previous.sizeBytes === next.sizeBytes && previous.linkTarget === next.linkTarget && JSON.stringify(previous.chunks) === JSON.stringify(next.chunks)) {
          continue; // identical (snapshots repeat unchanged entries)
        }
        if (previous) await keepVersion(sql`path = ${entry.p}`);
        await tx
          .insert(sandboxVolumeEntries)
          .values({ volumeId, path: entry.p, ...next, seq })
          .onConflictDoUpdate({ target: [sandboxVolumeEntries.volumeId, sandboxVolumeEntries.path], set: { ...next, seq } });
      }
      await insertChunks(tx, volumeId, newChunks);
      for (const [packKey, sizeBytes] of packSizes) {
        await tx.insert(sandboxVolumePacks).values({ volumeId, packKey, sizeBytes }).onConflictDoUpdate({ target: [sandboxVolumePacks.volumeId, sandboxVolumePacks.packKey], set: { sizeBytes } });
      }
      await tx.execute(sql`
        update sandbox_volumes set head_seq = ${seq}, updated_at = now(),
          file_count = (select count(*) from sandbox_volume_entries where volume_id = ${volumeId} and kind = 'f'),
          logical_bytes = (select coalesce(sum(size_bytes), 0) from sandbox_volume_entries where volume_id = ${volumeId} and kind = 'f'),
          stored_bytes = (select coalesce(sum(size_bytes), 0) from sandbox_volume_packs where volume_id = ${volumeId})
        where id = ${volumeId}`);
    });
  }

  /** Make the state at `seq` the new head. History stays linear: a rollback is itself a commit. */
  async rollback(volumeId: string, seq: number): Promise<number> {
    const rows = await this.entriesAt(volumeId, seq);
    return this.db.transaction(async (tx) => {
      const head = (await tx.select({ head: sandboxVolumes.headSeq }).from(sandboxVolumes).where(eq(sandboxVolumes.id, volumeId)).for("update"))[0]!.head;
      const next = head + 1;
      await tx.execute(sql`
        insert into sandbox_volume_entry_versions (volume_id, path, kind, mode, mtime_ns, size_bytes, link_target, chunks, from_seq, to_seq)
        select volume_id, path, kind, mode, mtime_ns, size_bytes, link_target, chunks, seq, ${next}
        from sandbox_volume_entries where volume_id = ${volumeId}`);
      await tx.execute(sql`delete from sandbox_volume_entries where volume_id = ${volumeId}`);
      for (let i = 0; i < rows.length; i += 1000) {
        const batch = rows.slice(i, i + 1000).map((r) => ({ volumeId, path: r.path, kind: r.kind, mode: r.mode, mtimeNs: r.mtimeNs, sizeBytes: r.sizeBytes, linkTarget: r.linkTarget, chunks: r.chunks, seq: next }));
        if (batch.length) await tx.insert(sandboxVolumeEntries).values(batch);
      }
      await tx.execute(sql`update sandbox_volumes set head_seq = ${next}, updated_at = now() where id = ${volumeId}`);
      return next;
    });
  }

  /** Repoint every chunk of `packKey` to `newKey` (after a server-side copy). */
  async repointPack(volumeId: string, packKey: string, newKey: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`update sandbox_volume_chunks set pack_key = ${newKey} where volume_id = ${volumeId} and pack_key = ${packKey}`);
      await tx.execute(sql`update sandbox_volume_packs set pack_key = ${newKey} where volume_id = ${volumeId} and pack_key = ${packKey}`);
    });
  }

  async planEntries(volumeId: string): Promise<{ entries: PlanEntry[]; chunkIds: Set<string> }> {
    const rows = await this.entries(volumeId);
    const chunkIds = new Set<string>();
    const entries: PlanEntry[] = rows.map((r) => {
      for (const [id] of r.chunks) chunkIds.add(id);
      return { p: r.path, k: r.kind, m: r.mode, t: r.mtimeNs.toString(), s: r.sizeBytes, l: r.linkTarget, c: r.chunks };
    });
    return { entries, chunkIds };
  }
}

async function insertChunks(tx: Tx, volumeId: string, chunks: Record<string, ChunkLocation>) {
  const items = Object.entries(chunks);
  for (let i = 0; i < items.length; i += 1000) {
    const batch = items.slice(i, i + 1000).map(([id, [packKey, off, compressedLength, rawLength]]) => ({ volumeId, chunkId: chunkIdBytes(id), packKey, off, compressedLength, rawLength }));
    if (batch.length) await tx.insert(sandboxVolumeChunks).values(batch).onConflictDoNothing();
  }
}
