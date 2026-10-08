import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  sandboxVolumeAttachments,
  sandboxVolumeChunks,
  sandboxVolumeCommits,
  sandboxVolumeDrains,
  sandboxVolumeEntries,
  sandboxVolumeEntryVersions,
  sandboxVolumePacks,
  sandboxVolumeRejects,
  sandboxVolumes,
} from "@sourceweft/db/schema";
import {
  enforceVolumeLimits,
  resolveVolumeLimits,
  type VolumeLimits,
} from "./quota";
import { ManifestRejected } from "../protocol/manifest";
import { descendantRange } from "../protocol/paths";
import type {
  ChunkLocation,
  EntryKind,
  Manifest,
  PlanEntry,
} from "../protocol/types";

/** Any drizzle node-postgres handle; the schema generic is not needed for the explicit queries used here. */
export type VolumeDatabase = NodePgDatabase<Record<string, unknown>>;
type Tx = Parameters<Parameters<VolumeDatabase["transaction"]>[0]>[0];

export type VolumeScope = {
  teamId: string;
  workspaceId: string;
  threadId: string;
  namespace?: string;
};

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

export class VolumeConflict extends Error {
  override readonly name = "VolumeConflict";
}

export type CommitIdentity = {
  epoch: number;
  manifestKey: string;
  manifestHash: string;
  drainId?: string;
};

export function attachmentCanWrite(
  actor: AttachmentRow,
  drainId?: string,
): boolean {
  return drainId === undefined
    ? actor.status === "active"
    : actor.status === "draining" && actor.drainId === drainId;
}

export class VolumeRepository {
  constructor(
    private readonly db: VolumeDatabase,
    private readonly limits: VolumeLimits = resolveVolumeLimits(),
  ) {}

  async getOrCreateVolume(id: string, scope: VolumeScope): Promise<VolumeRow> {
    const existing = await this.db
      .select()
      .from(sandboxVolumes)
      .where(
        and(
          eq(sandboxVolumes.teamId, scope.teamId),
          eq(sandboxVolumes.workspaceId, scope.workspaceId),
          eq(sandboxVolumes.threadId, scope.threadId),
          eq(sandboxVolumes.namespace, scope.namespace ?? "primary"),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
    await this.db
      .insert(sandboxVolumes)
      .values({ id, ...scope })
      .onConflictDoNothing();
    const created = await this.db
      .select()
      .from(sandboxVolumes)
      .where(
        and(
          eq(sandboxVolumes.teamId, scope.teamId),
          eq(sandboxVolumes.workspaceId, scope.workspaceId),
          eq(sandboxVolumes.threadId, scope.threadId),
          eq(sandboxVolumes.namespace, scope.namespace ?? "primary"),
        ),
      )
      .limit(1);
    return created[0]!;
  }

  async findVolume(scope: VolumeScope): Promise<VolumeRow | null> {
    const rows = await this.db
      .select()
      .from(sandboxVolumes)
      .where(
        and(
          eq(sandboxVolumes.teamId, scope.teamId),
          eq(sandboxVolumes.workspaceId, scope.workspaceId),
          eq(sandboxVolumes.threadId, scope.threadId),
          eq(sandboxVolumes.namespace, scope.namespace ?? "primary"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getVolume(id: string): Promise<VolumeRow | null> {
    const rows = await this.db
      .select()
      .from(sandboxVolumes)
      .where(eq(sandboxVolumes.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async head(volumeId: string): Promise<number> {
    const rows = await this.db
      .select({ head: sandboxVolumes.headSeq })
      .from(sandboxVolumes)
      .where(eq(sandboxVolumes.id, volumeId))
      .limit(1);
    if (!rows[0]) throw new Error(`volume ${volumeId} does not exist`);
    return rows[0].head;
  }

  async activeAttachment(volumeId: string): Promise<AttachmentRow | null> {
    const rows = await this.db
      .select()
      .from(sandboxVolumeAttachments)
      .where(
        and(
          eq(sandboxVolumeAttachments.volumeId, volumeId),
          eq(sandboxVolumeAttachments.status, "active"),
        ),
      )
      .orderBy(sql`${sandboxVolumeAttachments.createdAt} desc`)
      .limit(1);
    return rows[0] ?? null;
  }

  async getAttachment(id: string): Promise<AttachmentRow | null> {
    const rows = await this.db
      .select()
      .from(sandboxVolumeAttachments)
      .where(eq(sandboxVolumeAttachments.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async createAttachment(input: {
    id: string;
    volumeId: string;
    sandboxId: string | null;
    baseSeq: number;
    bootId?: string | null;
    expectedAttachmentId?: string | null;
  }): Promise<AttachmentRow> {
    return this.db.transaction(async (tx) => {
      const head = await this.lockVolume(tx, input.volumeId);
      const executing = await tx.execute(
        sql`select 1 from sandbox_volume_execution_permits where volume_id=${input.volumeId} and status='active' limit 1`,
      );
      if (executing.rows.length)
        throw new VolumeConflict(
          "volume has an unfinished execution permit; stop and checkpoint before replacement",
        );
      const quarantined = await tx
        .select()
        .from(sandboxVolumeAttachments)
        .where(
          and(
            eq(sandboxVolumeAttachments.volumeId, input.volumeId),
            sql`${sandboxVolumeAttachments.status} in ('quarantined','draining')`,
          ),
        )
        .limit(1);
      if (quarantined.length)
        throw new VolumeConflict(
          "volume has quarantined or draining attachment; recovery required",
        );
      const current = await tx
        .select()
        .from(sandboxVolumeAttachments)
        .where(
          and(
            eq(sandboxVolumeAttachments.volumeId, input.volumeId),
            eq(sandboxVolumeAttachments.status, "active"),
          ),
        );
      if (
        input.expectedAttachmentId !== undefined &&
        (current[0]?.id ?? null) !== input.expectedAttachmentId
      )
        throw new VolumeConflict(
          "attachment changed while preparing replacement",
        );
      await tx
        .update(sandboxVolumeAttachments)
        .set({ status: "superseded" })
        .where(
          and(
            eq(sandboxVolumeAttachments.volumeId, input.volumeId),
            eq(sandboxVolumeAttachments.status, "active"),
          ),
        );
      const rows = await tx
        .insert(sandboxVolumeAttachments)
        .values({
          id: input.id,
          volumeId: input.volumeId,
          sandboxId: input.sandboxId,
          baseSeq: head,
          lastAppliedSeq: head,
          bootId: input.bootId ?? null,
        })
        .returning();
      return rows[0]!;
    });
  }

  private async lockVolume(tx: Tx, volumeId: string): Promise<number> {
    const rows = await tx
      .select({ head: sandboxVolumes.headSeq })
      .from(sandboxVolumes)
      .where(eq(sandboxVolumes.id, volumeId))
      .for("update");
    if (!rows[0]) throw new Error(`volume ${volumeId} does not exist`);
    return rows[0].head;
  }

  /** An attachment's receipt, not another writer's global head, proves durability. */
  async confirmPersistence(
    attachmentId: string,
    seq: number,
    options: { drainId?: string; supervisorNonce?: string } = {},
  ): Promise<boolean> {
    if (!Number.isSafeInteger(seq) || seq < 0) return false;
    const attachment = await this.getAttachment(attachmentId);
    if (!attachment) return false;
    return this.db.transaction(async (tx) => {
      const head = await this.lockVolume(tx, attachment.volumeId);
      const actor = (
        await tx
          .select()
          .from(sandboxVolumeAttachments)
          .where(eq(sandboxVolumeAttachments.id, attachmentId))
      )[0];
      if (
        !actor ||
        !attachmentCanWrite(actor, options.drainId) ||
        seq < actor.baseSeq ||
        actor.lastAppliedSeq < seq
      )
        return false;
      if (options.drainId) {
        if (seq !== head || seq !== actor.lastAppliedSeq) return false;
        const drain = (
          await tx
            .select()
            .from(sandboxVolumeDrains)
            .where(eq(sandboxVolumeDrains.id, options.drainId))
        )[0];
        if (!drain?.stoppedAt) return false;
        if (
          drain.recoveryControllerNonce &&
          options.supervisorNonce !== drain.recoveryControllerNonce
        )
          return false;
        const external = await tx.execute(
          sql`select 1 from sandbox_volume_execution_permits where attachment_id=${attachmentId} and status='active' and writer_kind='external' limit 1`,
        );
        if (external.rows.length) return false;
        await tx
          .update(sandboxVolumeDrains)
          .set({ confirmedSeq: seq })
          .where(
            and(
              eq(sandboxVolumeDrains.id, options.drainId),
              eq(sandboxVolumeDrains.status, "draining"),
            ),
          );
      }
      return true;
    });
  }

  /** Rebase changes an active actor's epoch, never revives a superseded actor. */
  async advanceAttachmentEpoch(
    attachmentId: string,
    options: { drainId?: string } = {},
  ): Promise<AttachmentRow> {
    const attachment = await this.getAttachment(attachmentId);
    if (!attachment)
      throw new Error(`attachment ${attachmentId} does not exist`);
    return this.db.transaction(async (tx) => {
      await this.lockVolume(tx, attachment.volumeId);
      const rows = await tx
        .update(sandboxVolumeAttachments)
        .set({
          epoch: sql`${sandboxVolumeAttachments.epoch} + 1`,
          slotsUntilSeq: 0,
        })
        .where(
          and(
            eq(sandboxVolumeAttachments.id, attachmentId),
            eq(sandboxVolumeAttachments.volumeId, attachment.volumeId),
            options.drainId
              ? and(
                  eq(sandboxVolumeAttachments.status, "draining"),
                  eq(sandboxVolumeAttachments.drainId, options.drainId),
                )
              : eq(sandboxVolumeAttachments.status, "active"),
          ),
        )
        .returning();
      if (!rows[0])
        throw new Error(
          `attachment ${attachmentId} is not active (superseded or rejected)`,
        );
      return rows[0];
    });
  }

  async quarantineAttachment(id: string, reason: string): Promise<void> {
    const actor = await this.getAttachment(id);
    if (!actor) throw new VolumeConflict("attachment does not exist");
    await this.db.transaction(async (tx) => {
      await this.lockVolume(tx, actor.volumeId);
      const rows = await tx
        .update(sandboxVolumeAttachments)
        .set({ status: "quarantined", quarantineReason: reason.slice(0, 512) })
        .where(
          and(
            eq(sandboxVolumeAttachments.id, id),
            sql`${sandboxVolumeAttachments.status} in ('active', 'quarantined')`,
          ),
        )
        .returning();
      if (!rows.length)
        throw new VolumeConflict("cannot quarantine an inactive attachment");
    });
  }

  async issueControlToken(
    id: string,
    tokenHash: string,
    ttlSeconds: number,
    expectedHash?: string,
  ): Promise<AttachmentRow> {
    const actor = await this.getAttachment(id);
    if (!actor) throw new VolumeConflict("attachment does not exist");
    return this.db.transaction(async (tx) => {
      await this.lockVolume(tx, actor.volumeId);
      const rows = await tx
        .update(sandboxVolumeAttachments)
        .set({
          controlTokenHash: tokenHash,
          controlExpiresAt: sql`now() + (${ttlSeconds} * interval '1 second')`,
        })
        .where(
          and(
            eq(sandboxVolumeAttachments.id, id),
            eq(sandboxVolumeAttachments.status, "active"),
            expectedHash
              ? and(
                  eq(sandboxVolumeAttachments.controlTokenHash, expectedHash),
                  sql`${sandboxVolumeAttachments.controlExpiresAt} > now()`,
                )
              : undefined,
          ),
        )
        .returning();
      if (!rows[0])
        throw new VolumeConflict(
          "attachment is inactive or control credential changed",
        );
      return rows[0];
    });
  }

  /** Renew the same live credential only after a successful identity-bound control poll. */
  async renewControlToken(
    id: string,
    tokenHash: string,
    identity: { bootId: string; epoch: number },
    ttlSeconds: number,
  ): Promise<AttachmentRow | null> {
    const actor = await this.getAttachment(id);
    if (!actor) return null;
    return this.db.transaction(async (tx) => {
      await this.lockVolume(tx, actor.volumeId);
      const rows = await tx
        .update(sandboxVolumeAttachments)
        .set({
          controlExpiresAt: sql`greatest(${sandboxVolumeAttachments.controlExpiresAt},now()+(${ttlSeconds}*interval '1 second'))`,
        })
        .where(
          and(
            eq(sandboxVolumeAttachments.id, id),
            eq(sandboxVolumeAttachments.status, "active"),
            eq(sandboxVolumeAttachments.controlTokenHash, tokenHash),
            eq(sandboxVolumeAttachments.bootId, identity.bootId),
            eq(sandboxVolumeAttachments.epoch, identity.epoch),
            sql`${sandboxVolumeAttachments.controlExpiresAt} > now()`,
          ),
        )
        .returning();
      return rows[0] ?? null;
    });
  }

  async verifyControlToken(
    id: string,
    tokenHash: string,
  ): Promise<AttachmentRow | null> {
    const rows = await this.db
      .select()
      .from(sandboxVolumeAttachments)
      .where(
        and(
          eq(sandboxVolumeAttachments.id, id),
          eq(sandboxVolumeAttachments.status, "active"),
          eq(sandboxVolumeAttachments.controlTokenHash, tokenHash),
          sql`${sandboxVolumeAttachments.controlExpiresAt} > now()`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Identity binds once; changing a live daemon requires a new attachment. */
  async recordBootId(id: string, bootId: string): Promise<void> {
    if (!bootId.trim() || bootId.length > 256)
      throw new Error("invalid boot identity");
    const attachment = await this.getAttachment(id);
    if (!attachment) throw new VolumeConflict("attachment does not exist");
    await this.db.transaction(async (tx) => {
      await this.lockVolume(tx, attachment.volumeId);
      const rows = await tx
        .update(sandboxVolumeAttachments)
        .set({ bootId })
        .where(
          and(
            eq(sandboxVolumeAttachments.id, id),
            eq(sandboxVolumeAttachments.status, "active"),
            sql`(${sandboxVolumeAttachments.bootId} is null or ${sandboxVolumeAttachments.bootId} = ${bootId})`,
          ),
        )
        .returning();
      if (!rows.length)
        throw new VolumeConflict(
          "attachment is inactive or boot identity changed",
        );
    });
  }

  /** Reserve before signing; concurrent hosts never grant the same new pack range. */
  async reserveSlots(
    expected: AttachmentRow,
    packCount: number,
    seqCount: number,
    ttlSeconds: number,
    renewal?: { nextPack: number; lowWaterMark: number },
    drainId?: string,
  ) {
    if (
      renewal &&
      (!Number.isSafeInteger(renewal.nextPack) ||
        renewal.nextPack < 0 ||
        !Number.isSafeInteger(renewal.lowWaterMark) ||
        renewal.lowWaterMark < 1 ||
        renewal.lowWaterMark > packCount)
    )
      throw new Error("invalid slot renewal cursor");
    return this.db.transaction(async (tx) => {
      const head = await this.lockVolume(tx, expected.volumeId);
      const rows = await tx
        .select()
        .from(sandboxVolumeAttachments)
        .where(eq(sandboxVolumeAttachments.id, expected.id));
      const actor = rows[0];
      if (
        !actor ||
        !attachmentCanWrite(actor, drainId) ||
        actor.epoch !== expected.epoch
      )
        throw new VolumeConflict(
          "attachment is inactive or epoch changed during slot issuance",
        );
      const firstPack = actor.slotsUntilPack;
      if (renewal && renewal.nextPack > firstPack)
        throw new VolumeConflict(
          "slot renewal cursor exceeds the issued pack range",
        );
      const allocatePacks =
        !renewal || firstPack - renewal.nextPack < renewal.lowWaterMark
          ? packCount
          : 0;
      // Re-sign the outstanding sequence window as well: helpers must never skip head + 1.
      const lastSeq = Math.max(actor.slotsUntilSeq, head + seqCount);
      const registered = await tx.execute<{ next_pack: number }>(sql`
        select coalesce(max(substring(pack_key from ${`^att/${actor.id}/p/([0-9]{6})(?:\\.r[0-9a-f]+)*$`})::int) + 1, 0)::int as next_pack
        from sandbox_volume_packs where volume_id = ${actor.volumeId}`);
      const renewFromPack = registered.rows[0]?.next_pack ?? 0;
      if (firstPack + allocatePacks > 1_000_000)
        throw new Error("attachment pack slot namespace exhausted");
      const updated = await tx
        .update(sandboxVolumeAttachments)
        .set({
          slotsUntilPack: firstPack + allocatePacks,
          slotsUntilSeq: lastSeq,
          slotsExpireAt: sql`now() + (${ttlSeconds} * interval '1 second')`,
        })
        .where(eq(sandboxVolumeAttachments.id, actor.id))
        .returning();
      return {
        attachment: updated[0]!,
        firstPack,
        renewFromPack,
        firstSeq: head + 1,
        lastSeq,
      };
    });
  }

  async chunkLength(volumeId: string, chunkId: string): Promise<number | null> {
    const rows = await this.db
      .select({ length: sandboxVolumeChunks.rawLength })
      .from(sandboxVolumeChunks)
      .where(
        and(
          eq(sandboxVolumeChunks.volumeId, volumeId),
          eq(sandboxVolumeChunks.chunkId, chunkIdBytes(chunkId)),
        ),
      )
      .limit(1);
    return rows[0]?.length ?? null;
  }

  async chunkKnown(volumeId: string, chunkId: string): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(sandboxVolumeChunks)
      .where(
        and(
          eq(sandboxVolumeChunks.volumeId, volumeId),
          eq(sandboxVolumeChunks.chunkId, chunkIdBytes(chunkId)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async recordReject(input: {
    id: string;
    volumeId: string;
    attachmentId: string;
    seq: number;
    reason: string;
  }): Promise<void> {
    await this.db.insert(sandboxVolumeRejects).values(input);
  }

  async rejectCount(volumeId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sandboxVolumeRejects)
      .where(eq(sandboxVolumeRejects.volumeId, volumeId));
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
    const current = this.db
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
      .where(
        and(
          eq(sandboxVolumeEntries.volumeId, volumeId),
          lte(sandboxVolumeEntries.seq, seq),
        ),
      );
    const old = this.db
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
      .where(
        and(
          eq(sandboxVolumeEntryVersions.volumeId, volumeId),
          lte(sandboxVolumeEntryVersions.fromSeq, seq),
          gt(sandboxVolumeEntryVersions.toSeq, seq),
        ),
      );
    // A writer may archive current rows at any moment. One statement gives both
    // sources the same MVCC snapshot; two SELECTs can duplicate or omit history.
    const rows = await current.unionAll(old);
    return rows.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }

  async chunkLocations(
    volumeId: string,
    ids: Iterable<string>,
  ): Promise<Record<string, ChunkLocation>> {
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
        .where(
          and(
            eq(sandboxVolumeChunks.volumeId, volumeId),
            sql`${sandboxVolumeChunks.chunkId} = any(${sql.param(batch, sandboxVolumeChunks.chunkId)}::bytea[])`,
          ),
        );
      for (const row of rows)
        out[Buffer.from(row.id).toString("hex")] = [
          row.pack,
          row.off,
          row.clen,
          row.rlen,
        ];
    }
    return out;
  }

  /** Apply one validated manifest in a single transaction and advance the head. */
  async applyManifest(
    volumeId: string,
    manifest: Manifest,
    newChunks: Record<string, ChunkLocation>,
    packSizes: Map<string, number>,
    identity?: CommitIdentity,
  ): Promise<boolean> {
    const seq = manifest.seq;
    return this.db.transaction(async (tx) => {
      const head = await this.lockVolume(tx, volumeId);
      if (identity && manifest.seq <= head) {
        const receipts = await tx
          .select()
          .from(sandboxVolumeCommits)
          .where(
            and(
              eq(sandboxVolumeCommits.volumeId, volumeId),
              eq(sandboxVolumeCommits.seq, manifest.seq),
            ),
          );
        const receipt = receipts[0];
        if (
          receipt?.attachmentId === manifest.attachment &&
          receipt.epoch === identity.epoch &&
          receipt.manifestHash === identity.manifestHash &&
          receipt.manifestKey === identity.manifestKey
        )
          return false;
      }
      if (
        manifest.volume !== volumeId ||
        manifest.base !== head ||
        manifest.seq !== head + 1
      ) {
        throw new VolumeConflict(
          "manifest base/sequence does not match locked volume head",
        );
      }
      const actors = await tx
        .select()
        .from(sandboxVolumeAttachments)
        .where(
          and(
            eq(sandboxVolumeAttachments.id, manifest.attachment),
            eq(sandboxVolumeAttachments.volumeId, volumeId),
            identity?.drainId
              ? and(
                  eq(sandboxVolumeAttachments.status, "draining"),
                  eq(sandboxVolumeAttachments.drainId, identity.drainId),
                )
              : eq(sandboxVolumeAttachments.status, "active"),
          ),
        );
      if (!actors[0])
        throw new VolumeConflict(
          "manifest attachment is not active (superseded or rejected)",
        );
      const actor = actors[0]!;
      if (identity && actor.epoch !== identity.epoch)
        throw new VolumeConflict("manifest epoch changed while validating");
      if (actor.bootId !== null && manifest.boot_id !== actor.bootId)
        throw new VolumeConflict(
          "manifest boot identity changed while validating",
        );
      if (identity && seq > actor.slotsUntilSeq)
        throw new VolumeConflict("manifest sequence has no issued slot");
      const keepVersion = async (where: ReturnType<typeof sql>) => {
        await tx.execute(sql`
          insert into sandbox_volume_entry_versions (volume_id, path, kind, mode, mtime_ns, size_bytes, link_target, chunks, from_seq, to_seq)
          select volume_id, path, kind, mode, mtime_ns, size_bytes, link_target, chunks, seq, ${seq}
          from sandbox_volume_entries where volume_id = ${volumeId} and ${where}`);
      };
      const dropChildren = async (path: string) => {
        const { from, to } = descendantRange(path);
        // text_pattern_ops compares bytes. Locale-aware >/< can include sibling
        // directories such as a/ and Á/ in A/'s range under en_US/ICU collations.
        const under = sql`path ~>~ ${from} and path ~<~ ${to}`;
        await keepVersion(under);
        await tx.execute(
          sql`delete from sandbox_volume_entries where volume_id = ${volumeId} and ${under}`,
        );
      };
      if (manifest.full) {
        const keep = new Set((manifest.upserts ?? []).map((e) => e.p));
        const paths = await tx
          .select({ path: sandboxVolumeEntries.path })
          .from(sandboxVolumeEntries)
          .where(eq(sandboxVolumeEntries.volumeId, volumeId));
        for (const { path } of paths) {
          if (!keep.has(path)) {
            await keepVersion(sql`path = ${path}`);
            await tx.execute(
              sql`delete from sandbox_volume_entries where volume_id = ${volumeId} and path = ${path}`,
            );
          }
        }
      }
      for (const path of manifest.deletes ?? []) {
        await keepVersion(sql`path = ${path}`);
        await tx.execute(
          sql`delete from sandbox_volume_entries where volume_id = ${volumeId} and path = ${path}`,
        );
        await dropChildren(path);
      }
      for (const entry of manifest.upserts ?? []) {
        const old = await tx
          .select({
            kind: sandboxVolumeEntries.kind,
            mode: sandboxVolumeEntries.mode,
            mtimeNs: sandboxVolumeEntries.mtimeNs,
            sizeBytes: sandboxVolumeEntries.sizeBytes,
            linkTarget: sandboxVolumeEntries.linkTarget,
            chunks: sandboxVolumeEntries.chunks,
          })
          .from(sandboxVolumeEntries)
          .where(
            and(
              eq(sandboxVolumeEntries.volumeId, volumeId),
              eq(sandboxVolumeEntries.path, entry.p),
            ),
          )
          .limit(1);
        const previous = old[0];
        if (previous && previous.kind === "d" && entry.k !== "d")
          await dropChildren(entry.p); // a directory replaced by a file or link loses its children
        const next = {
          kind: entry.k,
          mode: entry.m,
          mtimeNs: BigInt(entry.t ?? "0"),
          sizeBytes: entry.s ?? 0,
          linkTarget: entry.l ?? null,
          chunks: entry.c ?? [],
        };
        if (
          previous &&
          previous.kind === next.kind &&
          previous.mode === next.mode &&
          previous.mtimeNs === next.mtimeNs &&
          previous.sizeBytes === next.sizeBytes &&
          previous.linkTarget === next.linkTarget &&
          JSON.stringify(previous.chunks) === JSON.stringify(next.chunks)
        ) {
          continue; // identical (snapshots repeat unchanged entries)
        }
        if (previous) await keepVersion(sql`path = ${entry.p}`);
        await tx
          .insert(sandboxVolumeEntries)
          .values({ volumeId, path: entry.p, ...next, seq })
          .onConflictDoUpdate({
            target: [sandboxVolumeEntries.volumeId, sandboxVolumeEntries.path],
            set: { ...next, seq },
          });
      }
      // Validate the resulting tree, including ancestors not mentioned by this delta.
      const parents = new Set<string>();
      for (const entry of manifest.upserts ?? []) {
        let path = entry.p;
        while (path.includes("/")) {
          path = path.slice(0, path.lastIndexOf("/"));
          parents.add(path);
        }
      }
      const parentPaths = [...parents];
      for (let start = 0; start < parentPaths.length; start += 5000) {
        const paths = parentPaths.slice(start, start + 5000);
        const rows = await tx
          .select({
            path: sandboxVolumeEntries.path,
            kind: sandboxVolumeEntries.kind,
          })
          .from(sandboxVolumeEntries)
          .where(
            and(
              eq(sandboxVolumeEntries.volumeId, volumeId),
              sql`${sandboxVolumeEntries.path} = any(${sql.param(paths)}::text[])`,
            ),
          );
        if (
          rows.length !== paths.length ||
          rows.some((row) => row.kind !== "d")
        )
          throw new ManifestRejected(
            "entry parent is missing or is not a directory",
          );
      }
      await insertChunks(tx, volumeId, newChunks);
      for (const [packKey, sizeBytes] of packSizes) {
        await tx
          .insert(sandboxVolumePacks)
          .values({ volumeId, packKey, sizeBytes })
          .onConflictDoUpdate({
            target: [sandboxVolumePacks.volumeId, sandboxVolumePacks.packKey],
            set: { sizeBytes },
          });
      }
      await this.checkLimits(tx, volumeId);
      await tx.execute(sql`
        update sandbox_volumes set head_seq = ${seq}, updated_at = now(),
          file_count = (select count(*) from sandbox_volume_entries where volume_id = ${volumeId} and kind = 'f'),
          logical_bytes = (select coalesce(sum(size_bytes), 0) from sandbox_volume_entries where volume_id = ${volumeId} and kind = 'f'),
          stored_bytes = (select coalesce(sum(size_bytes), 0) from sandbox_volume_packs where volume_id = ${volumeId})
        where id = ${volumeId}`);
      await tx
        .update(sandboxVolumeAttachments)
        .set({ lastAppliedSeq: seq })
        .where(eq(sandboxVolumeAttachments.id, manifest.attachment));
      if (identity)
        await tx.insert(sandboxVolumeCommits).values({
          volumeId,
          seq,
          attachmentId: manifest.attachment,
          epoch: identity.epoch,
          manifestKey: identity.manifestKey,
          manifestHash: identity.manifestHash,
        });
      return true;
    });
  }

  private async checkLimits(tx: Tx, volumeId: string): Promise<void> {
    const usage = await tx.execute<{
      entries: string;
      logical: string;
      file: string;
      objects: string;
    }>(sql`
        select count(*)::text as entries,
          coalesce(sum(case when kind = 'f' then size_bytes else 0 end),0)::text as logical,
          coalesce(max(case when kind = 'f' then size_bytes else 0 end),0)::text as file,
          (select coalesce(sum(size_bytes),0)::text from sandbox_volume_packs where volume_id = ${volumeId}) as objects
        from sandbox_volume_entries where volume_id = ${volumeId}`);
    const totals = usage.rows[0]!;
    enforceVolumeLimits(this.limits, {
      maxEntries: Number(totals.entries),
      maxLogicalBytes: Number(totals.logical),
      maxFileBytes: Number(totals.file),
      maxObjectBytes: Number(totals.objects),
    });
  }

  /** Make the state at `seq` the new head. History stays linear: a rollback is itself a commit. */
  async rollback(volumeId: string, seq: number): Promise<number> {
    if (!Number.isSafeInteger(seq) || seq < 0)
      throw new Error("invalid rollback sequence");
    return this.db.transaction(async (tx) => {
      const head = await this.lockVolume(tx, volumeId);
      const busy =
        await tx.execute(sql`select 1 from sandbox_volume_attachments where volume_id=${volumeId} and status='draining'
        union all select 1 from sandbox_volume_execution_permits where volume_id=${volumeId} and status='active' limit 1`);
      if (busy.rows.length)
        throw new VolumeConflict(
          "volume has an unfinished drain or execution permit",
        );
      if (seq > head)
        throw new Error("rollback sequence is beyond current head");
      const rows = await new VolumeRepository(
        tx as unknown as VolumeDatabase,
      ).entriesAt(volumeId, seq);
      // The old filesystem reflects the pre-rollback tree. Revoke its actor under
      // the same volume lock so it cannot acknowledge or rebase that tree over the rollback.
      await tx
        .update(sandboxVolumeAttachments)
        .set({ status: "superseded" })
        .where(
          and(
            eq(sandboxVolumeAttachments.volumeId, volumeId),
            eq(sandboxVolumeAttachments.status, "active"),
          ),
        );
      const next = head + 1;
      await tx.execute(sql`
        insert into sandbox_volume_entry_versions (volume_id, path, kind, mode, mtime_ns, size_bytes, link_target, chunks, from_seq, to_seq)
        select volume_id, path, kind, mode, mtime_ns, size_bytes, link_target, chunks, seq, ${next}
        from sandbox_volume_entries where volume_id = ${volumeId}`);
      await tx.execute(
        sql`delete from sandbox_volume_entries where volume_id = ${volumeId}`,
      );
      for (let i = 0; i < rows.length; i += 1000) {
        const batch = rows.slice(i, i + 1000).map((r) => ({
          volumeId,
          path: r.path,
          kind: r.kind,
          mode: r.mode,
          mtimeNs: r.mtimeNs,
          sizeBytes: r.sizeBytes,
          linkTarget: r.linkTarget,
          chunks: r.chunks,
          seq: next,
        }));
        if (batch.length) await tx.insert(sandboxVolumeEntries).values(batch);
      }
      await this.checkLimits(tx, volumeId);
      await tx.execute(
        sql`update sandbox_volumes set head_seq = ${next}, updated_at = now(),
          file_count = (select count(*) from sandbox_volume_entries where volume_id = ${volumeId} and kind = 'f'),
          logical_bytes = (select coalesce(sum(size_bytes), 0) from sandbox_volume_entries where volume_id = ${volumeId} and kind = 'f')
          where id = ${volumeId}`,
      );
      return next;
    });
  }

  async registeredPackSize(
    volumeId: string,
    packKey: string,
  ): Promise<number | null> {
    const rows = await this.db
      .select({ size: sandboxVolumePacks.sizeBytes })
      .from(sandboxVolumePacks)
      .where(
        and(
          eq(sandboxVolumePacks.volumeId, volumeId),
          eq(sandboxVolumePacks.packKey, packKey),
          sql`not exists(select 1 from sandbox_volume_gc_candidates g where g.volume_id=${volumeId} and g.pack_key=${packKey} and g.state in ('deleting','deleted'))`,
        ),
      )
      .limit(1);
    return rows[0]?.size ?? null;
  }

  /** Repoint every chunk of `packKey` to `newKey` (after a server-side copy). */
  async repointPack(
    volumeId: string,
    packKey: string,
    newKey: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`update sandbox_volume_chunks set pack_key = ${newKey} where volume_id = ${volumeId} and pack_key = ${packKey}`,
      );
      await tx.execute(
        sql`update sandbox_volume_packs set pack_key = ${newKey} where volume_id = ${volumeId} and pack_key = ${packKey}`,
      );
    });
  }

  /** A repeatable-read snapshot keeps tree, locations and head from different commits apart. */
  async planSnapshot(volumeId: string) {
    return this.db.transaction(
      async (tx) => {
        const view = new VolumeRepository(tx as unknown as VolumeDatabase);
        const seq = await view.head(volumeId);
        const { entries, chunkIds } = await view.planEntries(volumeId);
        const chunks = await view.chunkLocations(volumeId, chunkIds);
        if (Object.keys(chunks).length !== chunkIds.size)
          throw new Error("volume index has missing chunks");
        return { seq, entries, chunks };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async planEntries(
    volumeId: string,
  ): Promise<{ entries: PlanEntry[]; chunkIds: Set<string> }> {
    const rows = await this.entries(volumeId);
    const chunkIds = new Set<string>();
    const entries: PlanEntry[] = rows.map((r) => {
      for (const [id] of r.chunks) chunkIds.add(id);
      return {
        p: r.path,
        k: r.kind,
        m: r.mode,
        t: r.mtimeNs.toString(),
        s: r.sizeBytes,
        l: r.linkTarget,
        c: r.chunks,
      };
    });
    return { entries, chunkIds };
  }
}

async function insertChunks(
  tx: Tx,
  volumeId: string,
  chunks: Record<string, ChunkLocation>,
) {
  const items = Object.entries(chunks);
  for (let i = 0; i < items.length; i += 1000) {
    const batch = items
      .slice(i, i + 1000)
      .map(([id, [packKey, off, compressedLength, rawLength]]) => ({
        volumeId,
        chunkId: chunkIdBytes(id),
        packKey,
        off,
        compressedLength,
        rawLength,
      }));
    if (batch.length)
      await tx.insert(sandboxVolumeChunks).values(batch).onConflictDoNothing();
  }
}
