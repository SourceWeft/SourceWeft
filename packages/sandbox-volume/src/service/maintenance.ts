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
        sql`select 1 from sandbox_volume_attachments where volume_id=${volumeId} and status in ('active','quarantined','draining') limit 1`,
      );
      if (pinned.rows.length) {
        result.pinned = true;
        return [] as string[];
      }
      const rows = await tx.execute<{ pack_key: string }>(
        this.unreachable(volumeId, limit),
      );
      const keys = rows.rows.map((row) => row.pack_key);
      if (!dryRun && keys.length)
        await tx.execute(sql`
        insert into sandbox_volume_gc_candidates(volume_id,pack_key,not_before) values
        ${sql.join(
          keys.map(
            (key) =>
              sql`(${volumeId},${key},now()+(${this.graceMs}*interval '1 millisecond'))`,
          ),
          sql`, `,
        )}
        on conflict do nothing`);
      return keys;
    });
    result.candidates = candidates;
    if (dryRun || result.pinned) return result;
    // Recheck the whole bounded batch once under the writer lock. A tombstone
    // withdraws locators without discarding metadata before external success.
    const claimed = candidates.length
      ? await this.config.db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from sandbox_volumes where id=${volumeId} for update`,
          );
          const pinned = await tx.execute(
            sql`select 1 from sandbox_volume_attachments where volume_id=${volumeId} and status in ('active','quarantined','draining') limit 1`,
          );
          if (pinned.rows.length) {
            result.pinned = true;
            return [] as string[];
          }
          const eligible = await tx.execute<{ pack_key: string }>(
            this.unreachable(volumeId, limit, candidates),
          );
          const keys = eligible.rows.map((row) => row.pack_key);
          if (keys.length)
            await tx.execute(
              sql`update sandbox_volume_gc_candidates set state='deleting',attempts=attempts+1,last_error=null where volume_id=${volumeId} and pack_key=any(${sql.param(keys)}::text[])`,
            );
          return keys;
        })
      : [];
    for (const key of claimed) {
      try {
        await this.config.store.deleteObject!(
          `${this.config.keyPrefix}vol/${volumeId}/${key}`,
        );
        await this.config.db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from sandbox_volumes where id=${volumeId} for update`,
          );
          // External deletion has now positively succeeded. Remove only stale
          // locators still pointing to that object; concurrent fresh uploads of
          // the same hash may already have moved their row to another pack.
          await tx.execute(
            sql`delete from sandbox_volume_chunks where volume_id=${volumeId} and pack_key=${key}`,
          );
          await tx.execute(
            sql`delete from sandbox_volume_packs where volume_id=${volumeId} and pack_key=${key}`,
          );
          await tx.execute(
            sql`update sandbox_volume_gc_candidates set state='deleted',deleted_at=now(),last_error=null where volume_id=${volumeId} and pack_key=${key}`,
          );
          await tx.execute(
            sql`update sandbox_volumes set stored_bytes=(select coalesce(sum(size_bytes),0) from sandbox_volume_packs where volume_id=${volumeId})+(select coalesce(sum(size_bytes),0) from sandbox_volume_object_reservations where volume_id=${volumeId} and state='pending') where id=${volumeId}`,
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
  /** Expand retained trees once, not once per candidate chunk. History never expires here. */
  private unreachable(volumeId: string, limit: number, dueKeys?: string[]) {
    return sql`
      with referenced_chunks as materialized (
        select distinct j->>0 as id from (
          select chunks from sandbox_volume_entries where volume_id=${volumeId}
          union all select chunks from sandbox_volume_entry_versions where volume_id=${volumeId}
        ) e cross join lateral jsonb_array_elements(e.chunks) j
      ), referenced_packs as materialized (
        select distinct c.pack_key from sandbox_volume_chunks c
        join referenced_chunks r on r.id=encode(c.chunk_id,'hex') where c.volume_id=${volumeId}
      )
      select p.pack_key from sandbox_volume_packs p where p.volume_id=${volumeId}
        and not exists(select 1 from sandbox_volume_commits m where m.volume_id=p.volume_id and m.manifest_key=p.pack_key)
        and not exists(select 1 from sandbox_volume_attachments a where a.volume_id=p.volume_id and a.slots_expire_at>now() and starts_with(p.pack_key,'att/'||a.id||'/'))
        and not exists(select 1 from referenced_packs r where r.pack_key=p.pack_key)
        and not exists(select 1 from sandbox_volume_object_reservations r where r.volume_id=p.volume_id and r.state='pending' and (r.pack_key=p.pack_key or r.source_key=p.pack_key))
        and not exists(select 1 from sandbox_volume_gc_candidates g where g.volume_id=p.volume_id and g.pack_key=p.pack_key and g.state='deleted')
        ${dueKeys ? sql`and p.pack_key=any(${sql.param(dueKeys)}::text[]) and exists(select 1 from sandbox_volume_gc_candidates g where g.volume_id=p.volume_id and g.pack_key=p.pack_key and g.state in ('pending','deleting') and g.not_before<=now())` : sql``}
      order by p.pack_key limit ${limit}`;
  }
}
