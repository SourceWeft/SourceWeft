import { sql } from "drizzle-orm";
import type { VolumeDatabase } from "./repository";
import type { ObjectStore } from "../store/object-store";
export type GcResult = {
  dryRun: boolean;
  pinned: boolean;
  candidates: string[];
  deleted: string[];
  failures: string[];
};
export class VolumeMaintenance {
  private readonly graceMs: number;
  constructor(
    private readonly config: {
      db: VolumeDatabase;
      store: ObjectStore;
      keyPrefix: string;
      graceMs?: number;
    },
  ) {
    this.graceMs = config.graceMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.graceMs) || this.graceMs < 0)
      throw new Error("invalid GC grace period");
  }
  /** Dry-run is the default. Retained history never expires implicitly. */
  async collect(
    volumeId: string,
    options: { dryRun?: boolean; limit?: number } = {},
  ): Promise<GcResult> {
    const dryRun = options.dryRun !== false,
      limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("invalid GC batch limit");
    if (!dryRun && !this.config.store.deleteObject)
      throw new Error("object store does not support individual GC deletion");
    const result: GcResult = {
      dryRun,
      pinned: false,
      candidates: [],
      deleted: [],
      failures: [],
    };
    const candidates = await this.config.db.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`select id from sandbox_volumes where id=${volumeId} for update`,
      );
      if (!locked.rows.length) throw new Error("volume does not exist");
      const pinned = await tx.execute(
        sql`select 1 from sandbox_volume_attachments where volume_id=${volumeId} and status in ('active','quarantined') limit 1`,
      );
      if (pinned.rows.length) {
        result.pinned = true;
        return [] as string[];
      }
      const rows = await tx.execute<{ pack_key: string }>(sql`
    select p.pack_key from sandbox_volume_packs p
    where p.volume_id=${volumeId}
      and not exists(select 1 from sandbox_volume_commits m where m.volume_id=p.volume_id and m.manifest_key=p.pack_key)
      and not exists(
        select 1 from sandbox_volume_chunks c where c.volume_id=p.volume_id and c.pack_key=p.pack_key and (
          exists(select 1 from sandbox_volume_entries e, jsonb_array_elements(e.chunks) j where e.volume_id=c.volume_id and j->>0=encode(c.chunk_id,'hex'))
          or exists(select 1 from sandbox_volume_entry_versions e, jsonb_array_elements(e.chunks) j where e.volume_id=c.volume_id and j->>0=encode(c.chunk_id,'hex'))))
      and not exists(select 1 from sandbox_volume_gc_candidates g where g.volume_id=p.volume_id and g.pack_key=p.pack_key and g.state='deleted')
    order by p.pack_key limit ${limit}`);
      const keys = rows.rows.map((row) => row.pack_key);
      if (!dryRun)
        for (const key of keys)
          await tx.execute(sql`
    insert into sandbox_volume_gc_candidates(volume_id,pack_key,not_before)
    values(${volumeId},${key},now()+(${this.graceMs}*interval '1 millisecond')) on conflict do nothing`);
      return keys;
    });
    result.candidates = candidates;
    if (dryRun || result.pinned) return result;
    // Claim only previously registered objects, after a second reachability check under the same lock as writers.
    for (const key of candidates) {
      const claimed = await this.config.db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from sandbox_volumes where id=${volumeId} for update`,
        );
        const pinned = await tx.execute(
          sql`select 1 from sandbox_volume_attachments where volume_id=${volumeId} and status in ('active','quarantined') limit 1`,
        );
        if (pinned.rows.length) return false;
        const eligible = await tx.execute(sql`
     select 1 from sandbox_volume_gc_candidates g join sandbox_volume_packs p using(volume_id,pack_key)
     where g.volume_id=${volumeId} and g.pack_key=${key} and g.state in ('pending','deleting') and g.not_before<=now()
       and not exists(select 1 from sandbox_volume_commits m where m.volume_id=g.volume_id and m.manifest_key=g.pack_key)
       and not exists(select 1 from sandbox_volume_chunks c where c.volume_id=g.volume_id and c.pack_key=g.pack_key and (
          exists(select 1 from sandbox_volume_entries e,jsonb_array_elements(e.chunks) j where e.volume_id=c.volume_id and j->>0=encode(c.chunk_id,'hex'))
          or exists(select 1 from sandbox_volume_entry_versions e,jsonb_array_elements(e.chunks) j where e.volume_id=c.volume_id and j->>0=encode(c.chunk_id,'hex'))))
     for update of g`);
        if (!eligible.rows.length) return false;
        await tx.execute(
          sql`update sandbox_volume_gc_candidates set state='deleting',attempts=attempts+1,last_error=null where volume_id=${volumeId} and pack_key=${key}`,
        );
        // Once unreferenced locations are withdrawn, later attachments cannot newly refer to this object.
        await tx.execute(
          sql`delete from sandbox_volume_chunks where volume_id=${volumeId} and pack_key=${key}`,
        );
        return true;
      });
      if (!claimed) continue;
      try {
        await this.config.store.deleteObject!(
          `${this.config.keyPrefix}vol/${volumeId}/${key}`,
        );
        await this.config.db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from sandbox_volumes where id=${volumeId} for update`,
          );
          await tx.execute(
            sql`delete from sandbox_volume_packs where volume_id=${volumeId} and pack_key=${key}`,
          );
          await tx.execute(
            sql`update sandbox_volume_gc_candidates set state='deleted',deleted_at=now(),last_error=null where volume_id=${volumeId} and pack_key=${key}`,
          );
          await tx.execute(
            sql`update sandbox_volumes set stored_bytes=(select coalesce(sum(size_bytes),0) from sandbox_volume_packs where volume_id=${volumeId}) where id=${volumeId}`,
          );
        });
        result.deleted.push(key);
      } catch (error) {
        await this.config.db.execute(
          sql`update sandbox_volume_gc_candidates set last_error=${error instanceof Error ? error.name : "Error"} where volume_id=${volumeId} and pack_key=${key}`,
        );
        result.failures.push(key);
      }
    }
    return result;
  }
}
