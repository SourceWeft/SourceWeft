import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import {
  MANIFEST_SLOTS_PER_ISSUE,
  PACK_SLOTS_PER_ISSUE,
  PRESIGN_TTL_SECONDS,
} from "../protocol/constants";
import { ManifestRejected, parseManifestObject } from "../protocol/manifest";
import type { ChunkLocation, RestorePlan, SlotSet } from "../protocol/types";
import { validateManifest } from "../protocol/validate";
import type { ObjectStore } from "../store/object-store";
import { VolumeRepository, type AttachmentRow, type VolumeDatabase, type VolumeRow, type VolumeScope } from "./repository";

export type VolumeServiceConfig = {
  db: VolumeDatabase;
  store: ObjectStore;
  /** Bucket key prefix for everything this service writes, e.g. `sandbox-volumes/`. */
  keyPrefix: string;
  /** Pre-signed URL lifetime for slots and plans. */
  presignTtlSeconds?: number;
  now?: () => Date;
};

export type WalEntry = { seq: number; trigger?: string; upserts: number; deletes: number; tsMs?: number; unstable: number } | { seq: number; rejected: string };
export type ApplyWalResult = { applied: number; entries: WalEntry[]; rejected: string | null };

export type AttachFiles = { planUrl: string; slotsUrl: string; planBytes: number; planSeq: number };

function id(bytes = 6): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Host side of the volume protocol. Everything the sandbox can reach is a pre-signed URL produced
 * here; everything the sandbox sends back is validated before it touches the index.
 */
export class VolumeService {
  readonly repo: VolumeRepository;
  private readonly ttl: number;
  private readonly now: () => Date;
  /** Serialises WAL application per volume: two appliers would both try to take `head + 1`. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly config: VolumeServiceConfig) {
    this.repo = new VolumeRepository(config.db);
    this.ttl = config.presignTtlSeconds ?? PRESIGN_TTL_SECONDS;
    this.now = config.now ?? (() => new Date());
  }

  volumePrefix(volumeId: string): string {
    return `${this.config.keyPrefix}vol/${volumeId}/`;
  }

  async getOrCreateVolume(scope: VolumeScope): Promise<VolumeRow> {
    return this.repo.getOrCreateVolume(`v${id(6)}`, scope);
  }

  /**
   * Bind a sandbox instance to the volume. Whatever the previous attachment uploaded is applied
   * first, so nothing a dead sandbox managed to persist is lost.
   */
  async attach(volumeId: string, sandboxId: string | null): Promise<AttachmentRow> {
    const previous = await this.repo.activeAttachment(volumeId);
    if (previous) await this.applyWal(previous.id);
    const head = await this.repo.head(volumeId);
    return this.repo.createAttachment({ id: `a${id(6)}`, volumeId, sandboxId, baseSeq: head });
  }

  async recordBootId(attachmentId: string, bootId: string): Promise<void> {
    await this.repo.updateAttachment(attachmentId, { bootId });
  }

  packPrefix(attachment: AttachmentRow): string {
    return `att/${attachment.id}/p/`;
  }

  manifestPrefix(attachment: AttachmentRow): string {
    return `att/${attachment.id}/m/${attachment.epoch}/`;
  }

  /** Write-once slots for the next packs and manifests of this attachment's epoch. */
  async issueSlots(attachment: AttachmentRow): Promise<SlotSet> {
    const prefix = this.volumePrefix(attachment.volumeId);
    const head = await this.repo.head(attachment.volumeId);
    const packs: Record<string, string> = {};
    const manifests: Record<string, string> = {};
    const firstPack = attachment.slotsUntilPack;
    for (let n = firstPack; n < firstPack + PACK_SLOTS_PER_ISSUE; n++) {
      packs[String(n)] = await this.config.store.presignWriteOnce(`${prefix}${this.packPrefix(attachment)}${String(n).padStart(6, "0")}`, this.ttl);
    }
    for (let s = head + 1; s <= head + MANIFEST_SLOTS_PER_ISSUE; s++) {
      manifests[String(s)] = await this.config.store.presignWriteOnce(`${prefix}${this.manifestPrefix(attachment)}${s}`, this.ttl);
    }
    await this.repo.updateAttachment(attachment.id, {
      slotsUntilPack: firstPack + PACK_SLOTS_PER_ISSUE,
      slotsUntilSeq: head + MANIFEST_SLOTS_PER_ISSUE,
      slotsExpireAt: new Date(this.now().getTime() + this.ttl * 1000),
    });
    return { volume: attachment.volumeId, attachment: attachment.id, pack_prefix: this.packPrefix(attachment), manifest_prefix: this.manifestPrefix(attachment), packs, manifests };
  }

  /** The restore plan: every entry, every needed chunk location, one GET URL per pack. */
  async plan(attachment: AttachmentRow): Promise<RestorePlan> {
    const prefix = this.volumePrefix(attachment.volumeId);
    const { entries, chunkIds } = await this.repo.planEntries(attachment.volumeId);
    const chunks = await this.repo.chunkLocations(attachment.volumeId, chunkIds);
    const packs: Record<string, string> = {};
    for (const location of Object.values(chunks)) {
      const key = location[0];
      if (!(key in packs)) packs[key] = await this.config.store.presignGet(`${prefix}${key}`, this.ttl);
    }
    return { volume: attachment.volumeId, attachment: attachment.id, seq: await this.repo.head(attachment.volumeId), entries, chunks, packs };
  }

  /** Put the plan and the slots in the bucket and hand back one GET URL for each (what the sandbox-side attach command downloads). */
  async publishAttachFiles(attachment: AttachmentRow): Promise<AttachFiles> {
    const prefix = this.volumePrefix(attachment.volumeId);
    const plan = await this.plan(attachment);
    const planJson = Buffer.from(JSON.stringify(plan), "utf8");
    const planKey = `${prefix}att/${attachment.id}/plan-${id(4)}`;
    await this.config.store.put(planKey, zstdCompressSync(planJson), "application/zstd");
    const slotsUrl = await this.publishSlots(attachment);
    return { planUrl: await this.config.store.presignGet(planKey, 900), slotsUrl, planBytes: planJson.length, planSeq: plan.seq };
  }

  async publishSlots(attachment: AttachmentRow): Promise<string> {
    const fresh = (await this.repo.getAttachment(attachment.id)) ?? attachment;
    const slots = await this.issueSlots(fresh);
    const key = `${this.volumePrefix(attachment.volumeId)}att/${attachment.id}/slots-${fresh.epoch}-${id(4)}`;
    await this.config.store.put(key, Buffer.from(JSON.stringify(slots), "utf8"), "application/json");
    return this.config.store.presignGet(key, 900);
  }

  /** Apply every manifest the sandbox has uploaded past the current head, in order. Stops at the first gap or rejection. */
  async applyWal(attachmentId: string): Promise<ApplyWalResult> {
    const attachment = await this.repo.getAttachment(attachmentId);
    if (!attachment) throw new Error(`attachment ${attachmentId} does not exist`);
    return this.withLock(attachment.volumeId, () => this.applyWalLocked(attachment));
  }

  private async applyWalLocked(attachment: AttachmentRow): Promise<ApplyWalResult> {
    const prefix = this.volumePrefix(attachment.volumeId);
    const result: ApplyWalResult = { applied: 0, entries: [], rejected: null };
    for (;;) {
      const head = await this.repo.head(attachment.volumeId);
      const seq = head + 1;
      const ownKey = `${this.manifestPrefix(attachment)}${seq}`;
      const raw = await this.config.store.get(`${prefix}${ownKey}`);
      if (raw === null) break;
      try {
        const parsed = parseManifestObject(raw);
        const validated = await validateManifest(parsed.manifest, {
          volumeId: attachment.volumeId,
          attachmentId: attachment.id,
          head,
          packPrefix: this.packPrefix(attachment),
          ownKey,
          rawLength: parsed.rawLength,
          inlineRange: parsed.inlineRange,
          chunkKnown: (chunkId) => this.repo.chunkKnown(attachment.volumeId, chunkId),
          packSize: (key) => this.config.store.size(`${prefix}${key}`),
        });
        await this.repo.applyManifest(attachment.volumeId, validated.manifest, validated.newChunks, validated.packSizes);
        result.applied += 1;
        const m = validated.manifest;
        result.entries.push({ seq, trigger: m.trigger, upserts: m.upserts?.length ?? 0, deletes: m.deletes?.length ?? 0, tsMs: m.ts_ms, unstable: m.unstable?.length ?? 0 });
      } catch (error) {
        const reason = error instanceof ManifestRejected ? error.message : `unparseable: ${String((error as Error)?.message ?? error).slice(0, 120)}`;
        await this.repo.recordReject({ id: `r${id(6)}`, volumeId: attachment.volumeId, attachmentId: attachment.id, seq, reason });
        result.entries.push({ seq, rejected: reason });
        result.rejected = reason;
        break; // the chain stops here; the attachment must rebase onto a new epoch
      }
    }
    return result;
  }

  /**
   * After a rejection the write-once slots of the refused chain can never be reused: start a new
   * epoch and hand out fresh slots. The helper then commits a self-contained snapshot based on head.
   */
  async beginRebase(attachmentId: string): Promise<{ attachment: AttachmentRow; slotsUrl: string; head: number }> {
    const attachment = await this.repo.getAttachment(attachmentId);
    if (!attachment) throw new Error(`attachment ${attachmentId} does not exist`);
    await this.repo.updateAttachment(attachment.id, { epoch: attachment.epoch + 1 });
    const fresh = (await this.repo.getAttachment(attachment.id))!;
    const slotsUrl = await this.publishSlots(fresh);
    return { attachment: fresh, slotsUrl, head: await this.repo.head(attachment.volumeId) };
  }

  /** A pack that will not download from the sandbox is copied server-side to a new key and repointed. */
  async repairPack(volumeId: string, packKey: string): Promise<string> {
    const prefix = this.volumePrefix(volumeId);
    const newKey = `${packKey}.r${id(3)}`;
    await this.config.store.copy(`${prefix}${packKey}`, `${prefix}${newKey}`);
    await this.repo.repointPack(volumeId, packKey, newKey);
    return newKey;
  }

  /** Make the state at `seq` the new head (point-in-time recovery). Returns the new head. */
  async rollback(volumeId: string, seq: number): Promise<number> {
    return this.withLock(volumeId, () => this.repo.rollback(volumeId, seq));
  }

  async chunkLocations(volumeId: string, ids: Iterable<string>): Promise<Record<string, ChunkLocation>> {
    return this.repo.chunkLocations(volumeId, ids);
  }

  private async withLock<T>(volumeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(volumeId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(volumeId, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(volumeId) === settled) this.locks.delete(volumeId);
    }
  }
}
