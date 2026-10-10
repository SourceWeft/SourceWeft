import { performance } from "node:perf_hooks";
import {
  resolveVolumeLimits,
  VolumeQuotaExceeded,
  type VolumeLimits,
} from "./quota";
import {
  VolumeLifecycle,
  type DrainRequest,
  type InstanceIdentity,
  type SupervisorStopProof,
  type PermitRelease,
  type VolumeWriterKind,
  type SupervisorRecoveryProof,
  type ProviderAbsenceEvidence,
  type RecoveryCandidatesOptions,
} from "./lifecycle";
import {
  parseCaptureProgress,
  captureWindow,
  CaptureProgressRejected,
  MAX_CAPTURE_PACK_BYTES,
} from "./capture-progress";
import { VolumeMaintenance } from "./maintenance";
import { createHash, randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import {
  MANIFEST_SLOTS_PER_ISSUE,
  MAX_MANIFEST_OBJECT_BYTES,
  PACK_SLOTS_PER_ISSUE,
  PRESIGN_TTL_SECONDS,
} from "../protocol/constants";
import { ManifestRejected, parseManifestObject } from "../protocol/manifest";
import type {
  CaptureProgress,
  ChunkLocation,
  RestorePlan,
  SlotSet,
} from "../protocol/types";
import { validateManifest } from "../protocol/validate";
import type { ObjectStore } from "../store/object-store";
import {
  VolumeRepository,
  attachmentCanWrite,
  VolumeConflict,
  type AttachmentRow,
  type ExpectedCapture,
  type VolumeDatabase,
  type VolumeRow,
  type VolumeScope,
} from "./repository";

export type VolumeTimedPhase =
  | "manifest_get"
  | "manifest_parse"
  | "chunk_lookup"
  | "manifest_validate"
  | "manifest_apply";
/** Numeric/category-only observations: never keys, URLs, credentials or file paths. */
export type VolumeMetric =
  | {
      phase: VolumeTimedPhase;
      durationMs: number;
      outcome: "ok" | "missing" | "error" | "replayed";
      bytes?: number;
    }
  | {
      phase: "pack_heads";
      count: number;
      sumMs: number;
      wallMs: number;
      maxInFlight: number;
      missing: number;
      failed: number;
    };

export type VolumeServiceConfig = {
  db: VolumeDatabase;
  store: ObjectStore;
  /** Bucket key prefix for everything this service writes, e.g. `sandbox-volumes/`. */
  keyPrefix: string;
  /** Pre-signed URL lifetime for slots and plans. */
  presignTtlSeconds?: number;
  now?: () => Date;
  limits?: Partial<VolumeLimits>;
  gcGraceMs?: number;
  /** Optional synchronous observer; failures never change persistence and increment metricObserverFailures. */
  onMetric?: (event: Readonly<VolumeMetric>) => void;
};

export type ControlRequest = {
  nextPack: number;
  epoch: number;
  bootId: string;
  seq: number;
  locatorChunkIds?: string[];
};
export class VolumeControlUnauthorized extends Error {
  override readonly name = "VolumeControlUnauthorized";
  constructor() {
    super("attachment control credential is invalid, expired, or fenced");
  }
}
function controlHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type WalEntry =
  | {
      seq: number;
      trigger?: string;
      upserts: number;
      deletes: number;
      tsMs?: number;
      unstable: number;
    }
  | { seq: number; rejected: string };
export type ApplyWalResult = {
  applied: number;
  entries: WalEntry[];
  rejected: string | null;
  /** Budget exhausted; another invocation should continue (does not perform a speculative GET). */
  hasMore?: boolean;
};

export type AttachFiles = {
  planUrl: string;
  slotsUrl: string;
  planBytes: number;
  planSeq: number;
};

function id(bytes = 6): string {
  return randomBytes(bytes).toString("hex");
}

// Limit repair verification to one operation per process across service instances.
// Persistent reservations, not this memory limiter, coordinate distinct hosts.
let repairVerification = Promise.resolve();
async function boundedRepair<T>(work: () => Promise<T>): Promise<T> {
  const run = repairVerification.then(work, work);
  repairVerification = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Host side of the volume protocol. Everything the sandbox can reach is a pre-signed URL produced
 * here; everything the sandbox sends back is validated before it touches the index.
 */
export class VolumeService {
  private observerFailures = 0;
  get metricObserverFailures(): number {
    return this.observerFailures;
  }
  readonly repo: VolumeRepository;
  readonly maintenance: VolumeMaintenance;
  readonly lifecycle: VolumeLifecycle;
  private readonly limits: VolumeLimits;
  // Only progress objects returned by this service carry measured cumulative quota authority.
  private readonly captures = new WeakMap<
    CaptureProgress,
    { packs: Map<number, number>; verifiedBytes: number; unknownPacks: number }
  >();
  private readonly ttl: number;
  private readonly now: () => Date;
  /** Serialises WAL application per volume: two appliers would both try to take `head + 1`. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly config: VolumeServiceConfig) {
    this.limits = resolveVolumeLimits(config.limits);
    this.repo = new VolumeRepository(config.db, this.limits);
    this.lifecycle = new VolumeLifecycle(config.db);
    this.maintenance = new VolumeMaintenance({
      db: config.db,
      store: config.store,
      keyPrefix: config.keyPrefix,
      graceMs: config.gcGraceMs,
    });
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
  async attach(
    volumeId: string,
    sandboxId: string | null,
    replacement?: { expectedAttachmentId: string },
  ): Promise<AttachmentRow> {
    const previous = await this.repo.activeAttachment(volumeId);
    if (previous && replacement?.expectedAttachmentId !== previous.id)
      throw new VolumeConflict(
        "volume already has an active attachment; resume or explicit instance-replacement recovery required",
      );
    if (replacement && replacement.expectedAttachmentId !== previous?.id)
      throw new VolumeConflict("replacement attachment changed");
    if (previous) {
      const wal = await this.applyWal(previous.id);
      if (wal.rejected)
        throw new VolumeConflict(
          `previous attachment WAL rejected; explicit recovery required: ${wal.rejected}`,
        );
    }
    const head = await this.repo.head(volumeId);
    return this.repo.createAttachment({
      id: `a${id(6)}`,
      volumeId,
      sandboxId,
      baseSeq: head,
      expectedAttachmentId: previous?.id ?? null,
    });
  }

  async confirmPersistence(
    attachmentId: string,
    seq: number,
    options: { drainId?: string; supervisorNonce?: string } = {},
  ): Promise<boolean> {
    return this.repo.confirmPersistence(attachmentId, seq, options);
  }

  recoverSupervisor(
    id: string,
    input: { operationId: string; proof: SupervisorRecoveryProof },
  ) {
    return this.lifecycle.recoverSupervisor(id, input);
  }
  auditProviderAbsence(
    id: string,
    input: { operationId: string; evidence: ProviderAbsenceEvidence },
  ) {
    return this.lifecycle.auditProviderAbsence(id, input);
  }
  listRecoveryCandidates(options: RecoveryCandidatesOptions = {}) {
    return this.lifecycle.listRecoveryCandidates(options);
  }

  bindSupervisorIdentity(id: string, nonce: string) {
    return this.lifecycle.bindSupervisorIdentity(id, nonce);
  }
  acquireExecutionPermit(
    id: string,
    input: InstanceIdentity & {
      operationId: string;
      writerKind?: VolumeWriterKind;
    },
  ) {
    return this.lifecycle.acquireExecutionPermit(id, input);
  }
  markExecutionStarted(id: string, permitId: string) {
    return this.lifecycle.markExecutionStarted(id, permitId);
  }
  releaseExecutionPermit(id: string, permitId: string, result: PermitRelease) {
    return this.lifecycle.releaseExecutionPermit(id, permitId, result);
  }
  beginDrain(id: string, input: DrainRequest) {
    return this.lifecycle.beginDrain(id, input);
  }
  recordSupervisorStop(id: string, proof: SupervisorStopProof) {
    return this.lifecycle.recordSupervisorStop(id, proof);
  }
  finishDrain(
    id: string,
    input: {
      drainId: string;
      confirmedSeq: number;
      stopProof: SupervisorStopProof;
    },
  ) {
    return this.lifecycle.finishDrain(id, input);
  }

  async quarantineAttachment(
    attachmentId: string,
    reason: string,
  ): Promise<void> {
    await this.repo.quarantineAttachment(attachmentId, reason);
  }

  async assertAttachmentActive(attachmentId: string): Promise<void> {
    const actor = await this.repo.getAttachment(attachmentId);
    if (!actor || actor.status !== "active")
      throw new Error("attachment is not active; recovery required");
  }

  /** Host-only bootstrap operation. New issuance immediately revokes the previous credential. */
  async issueControlToken(
    attachmentId: string,
    options: { ttlSeconds?: number } = {},
  ) {
    return this.writeControlToken(
      attachmentId,
      options.ttlSeconds ?? 24 * 60 * 60,
    );
  }

  async verifyControlToken(
    attachmentId: string,
    token: string,
  ): Promise<AttachmentRow> {
    if (!/^svctl_[A-Za-z0-9_-]{43}$/.test(token))
      throw new VolumeControlUnauthorized();
    const actor = await this.repo.verifyControlToken(
      attachmentId,
      controlHash(token),
    );
    if (!actor) throw new VolumeControlUnauthorized();
    return actor;
  }

  /** Explicit credential rotation. Callers persist the replacement before using it; no command is replayed. */
  async rotateControlToken(
    attachmentId: string,
    token: string,
    options: { ttlSeconds?: number } = {},
  ) {
    await this.verifyControlToken(attachmentId, token);
    return this.writeControlToken(
      attachmentId,
      options.ttlSeconds ?? 24 * 60 * 60,
      controlHash(token),
    );
  }

  private async writeControlToken(
    attachmentId: string,
    ttlSeconds: number,
    expectedHash?: string,
  ) {
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 7 * 24 * 60 * 60
    )
      throw new Error("invalid control credential lifetime");
    const token = `svctl_${randomBytes(32).toString("base64url")}`;
    const actor = await this.repo.issueControlToken(
      attachmentId,
      controlHash(token),
      ttlSeconds,
      expectedHash,
    );
    return { token, expiresAt: actor.controlExpiresAt!.toISOString() };
  }

  /** One authenticated daemon poll: acknowledge uploaded WAL and renew only this attachment's capabilities. */
  async refreshControl(
    attachmentId: string,
    token: string,
    request: ControlRequest,
  ) {
    if (
      !request ||
      !Number.isSafeInteger(request.nextPack) ||
      request.nextPack < 0 ||
      !Number.isSafeInteger(request.epoch) ||
      request.epoch < 0 ||
      !Number.isSafeInteger(request.seq) ||
      request.seq < 0 ||
      typeof request.bootId !== "string" ||
      !request.bootId ||
      request.bootId.length > 256
    )
      throw new Error("invalid attachment control request");
    const actor = await this.verifyControlToken(attachmentId, token);
    if (
      actor.bootId !== request.bootId ||
      actor.epoch !== request.epoch ||
      request.seq < actor.baseSeq ||
      request.seq > actor.slotsUntilSeq ||
      request.nextPack > actor.slotsUntilPack
    )
      throw new VolumeConflict(
        "attachment control identity or cursor does not match current grant",
      );
    if (
      request.locatorChunkIds !== undefined &&
      (!Array.isArray(request.locatorChunkIds) ||
        request.locatorChunkIds.length > 256 ||
        request.locatorChunkIds.some(
          (id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id),
        ))
    )
      throw new Error("invalid locator request");
    const wal = await this.applyWal(attachmentId, { maxCommits: 16 });
    if (wal.rejected)
      throw new VolumeConflict("attachment WAL requires explicit recovery");
    const fresh = await this.verifyControlToken(attachmentId, token);
    if (fresh.epoch !== request.epoch || fresh.bootId !== request.bootId)
      throw new VolumeConflict("attachment changed during control refresh");
    const slots = await this.issueSlots(fresh, { nextPack: request.nextPack });
    const chunks = await this.repo.chunkLocations(
      fresh.volumeId,
      request.locatorChunkIds ?? [],
    );
    if (
      Object.keys(chunks).length !== new Set(request.locatorChunkIds ?? []).size
    )
      throw new VolumeConflict(
        "requested locator is not registered to this volume",
      );
    const packs: Record<string, string> = {};
    for (const [key] of Object.values(chunks))
      if (!Object.hasOwn(packs, key))
        packs[key] = await this.config.store.presignGet(
          `${this.volumePrefix(fresh.volumeId)}${key}`,
          this.ttl,
        );
    const head = await this.repo.head(fresh.volumeId);
    const final = await this.repo.renewControlToken(
      attachmentId,
      controlHash(token),
      { bootId: request.bootId, epoch: request.epoch },
      24 * 60 * 60,
    );
    if (!final) throw new VolumeControlUnauthorized();
    return {
      head,
      confirmedSeq: Math.min(final.lastAppliedSeq, request.seq),
      epoch: final.epoch,
      hasMore: wal.hasMore ?? false,
      slots,
      slotsExpiresAt: final.slotsExpireAt!.toISOString(),
      controlExpiresAt: final.controlExpiresAt!.toISOString(),
      locators: { chunks, packs },
    };
  }

  private emitMetric(event: VolumeMetric): void {
    try {
      const result: unknown = this.config.onMetric?.(Object.freeze(event));
      // An accidentally async observer must not introduce an unhandled rejection.
      if (result && typeof (result as { then?: unknown }).then === "function")
        void Promise.resolve(result).catch(() => {
          this.observerFailures++;
        });
    } catch {
      this.observerFailures++;
    }
  }
  private async measured<T>(
    phase: VolumeTimedPhase,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!this.config.onMetric) return work();
    const started = performance.now();
    try {
      const value = await work();
      this.emitMetric({
        phase,
        durationMs: performance.now() - started,
        outcome:
          value === null
            ? "missing"
            : phase === "manifest_apply" && value === false
              ? "replayed"
              : "ok",
        ...(phase === "manifest_get" && value instanceof Uint8Array
          ? { bytes: value.byteLength }
          : {}),
      });
      return value;
    } catch (error) {
      this.emitMetric({
        phase,
        durationMs: performance.now() - started,
        outcome: "error",
      });
      throw error;
    }
  }
  private measuredParse(raw: Uint8Array) {
    if (!this.config.onMetric) return parseManifestObject(raw);
    const started = performance.now();
    try {
      const value = parseManifestObject(raw);
      this.emitMetric({
        phase: "manifest_parse",
        durationMs: performance.now() - started,
        outcome: "ok",
      });
      return value;
    } catch (error) {
      this.emitMetric({
        phase: "manifest_parse",
        durationMs: performance.now() - started,
        outcome: "error",
      });
      throw error;
    }
  }

  async recordBootId(attachmentId: string, bootId: string): Promise<void> {
    await this.repo.recordBootId(attachmentId, bootId);
  }

  packPrefix(attachment: AttachmentRow): string {
    return `att/${attachment.id}/p/`;
  }

  manifestPrefix(attachment: AttachmentRow): string {
    return `att/${attachment.id}/m/${attachment.epoch}/`;
  }

  /** Write-once slots for the next packs and manifests of this attachment's epoch. */
  async issueSlots(
    attachment: AttachmentRow,
    renewal?: {
      nextPack?: number;
      drainId?: string;
      expectedCapture?: ExpectedCapture;
      signal?: AbortSignal;
    },
  ): Promise<SlotSet> {
    if (!this.config.store.presignWriteOnceGrant)
      throw new Error(
        "object store must provide authoritative signed grant expiry",
      );
    let maxExpiry = 0,
      minExpiry = Number.POSITIVE_INFINITY;
    const grant = async (key: string): Promise<string> => {
      const { url, expiresAt } = await this.config.store.presignWriteOnceGrant!(
        key,
        this.ttl,
      );
      const expiry = Date.prototype.getTime.call(expiresAt);
      if (
        typeof url !== "string" ||
        !url ||
        !Number.isSafeInteger(expiry) ||
        expiry <= 0
      )
        throw new Error("invalid signed write grant metadata");
      // Snapshot the numeric value now; a signer-owned Date must not mutate our bound.
      maxExpiry = Math.max(maxExpiry, expiry);
      minExpiry = Math.min(minExpiry, expiry);
      return url;
    };
    const prefix = this.volumePrefix(attachment.volumeId);
    const reservation = await this.repo.reserveSlots(
      attachment,
      PACK_SLOTS_PER_ISSUE,
      MANIFEST_SLOTS_PER_ISSUE,
      this.ttl,
      renewal?.nextPack !== undefined
        ? {
            nextPack: renewal.nextPack,
            lowWaterMark: Math.min(16, PACK_SLOTS_PER_ISSUE),
          }
        : undefined,
      renewal?.drainId,
      renewal?.expectedCapture,
      renewal?.signal,
    );
    renewal?.signal?.throwIfAborted();
    attachment = reservation.attachment;
    const packs: Record<string, string> = {};
    const manifests: Record<string, string> = {};
    const manifestReads: Record<string, string> = {};
    for (
      let n = reservation.renewFromPack;
      n < attachment.slotsUntilPack;
      n++
    ) {
      renewal?.signal?.throwIfAborted();
      packs[String(n)] = await grant(
        `${prefix}${this.packPrefix(attachment)}${String(n).padStart(6, "0")}`,
      );
    }
    // A WAL applier can be one commit ahead of the helper's durable state.
    // Permit read-back of that occupied head, never another PUT to the spent seq.
    if (reservation.firstSeq > 1) {
      renewal?.signal?.throwIfAborted();
      const head = reservation.firstSeq - 1;
      manifestReads[String(head)] = await this.config.store.presignGet(
        `${prefix}${this.manifestPrefix(attachment)}${head}`,
        this.ttl,
      );
    }
    for (let s = reservation.firstSeq; s <= reservation.lastSeq; s++) {
      renewal?.signal?.throwIfAborted();
      const key = `${prefix}${this.manifestPrefix(attachment)}${s}`;
      manifests[String(s)] = await grant(key);
      renewal?.signal?.throwIfAborted();
      // A PUT grant cannot read an occupied immutable slot. Recovery must compare
      // its exact pending bytes through an independently signed GET for this key.
      manifestReads[String(s)] = await this.config.store.presignGet(
        key,
        this.ttl,
      );
    }
    await this.repo.finalizeSlotGrants(attachment, new Date(maxExpiry), {
      drainId: renewal?.drainId,
      expectedCapture: renewal?.expectedCapture,
      signal: renewal?.signal,
      earliestExpiry: new Date(minExpiry),
    });
    renewal?.signal?.throwIfAborted();
    return {
      volume: attachment.volumeId,
      attachment: attachment.id,
      pack_prefix: this.packPrefix(attachment),
      manifest_prefix: this.manifestPrefix(attachment),
      packs,
      manifests,
      manifest_reads: manifestReads,
    };
  }

  /** Upload authorization only: neither stdout nor HEAD confirms a tree or WAL receipt.
   * `previous` must be the exact object returned by this service, never a deserialized clone.
   * The returned byte count measures only this window; cumulative quota authority stays here.
   * Unseen prefix packs are charged 64 MiB each and may fail closed despite fitting in reality.
   * This is an operation budget, not a complete inventory or physical pending-storage quota.
   */
  async renewCaptureSlots(
    attachmentId: string,
    candidate: unknown,
    previous?: CaptureProgress,
    options: { drainId?: string; signal?: AbortSignal } = {},
  ): Promise<{
    slotsUrl: string;
    progress: CaptureProgress;
    verifiedObjectBytes: number;
  }> {
    if (options.signal !== undefined)
      AbortSignal.prototype.throwIfAborted.call(options.signal);
    const progress = parseCaptureProgress(candidate, this.limits);
    const prior =
      previous === undefined
        ? undefined
        : parseCaptureProgress(previous, this.limits);
    const memo =
      previous === undefined ? undefined : this.captures.get(previous);
    if (previous !== undefined && !memo)
      throw new CaptureProgressRejected(
        "previous capture progress was not verified by this service",
      );
    const numbers = captureWindow(progress, prior);
    const check = async () => {
      options.signal?.throwIfAborted();
      const actor = await this.repo.getAttachment(attachmentId);
      if (
        !actor ||
        !attachmentCanWrite(actor, options.drainId) ||
        actor.id !== progress.attachment ||
        actor.volumeId !== progress.volume ||
        actor.bootId !== progress.boot_id ||
        actor.epoch !== progress.epoch ||
        progress.next_pack > actor.slotsUntilPack ||
        numbers.some((n) => n >= actor.slotsUntilPack)
      )
        throw new VolumeConflict(
          "capture progress attachment is fenced or outside issued slots",
        );
      const volume = await this.repo.getVolume(actor.volumeId);
      if (!volume || volume.headSeq !== progress.base_seq)
        throw new VolumeConflict("capture progress head changed");
      return { actor, volume };
    };
    const { actor } = await check();
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const measured = new Map<number, number>();
    let cursor = 0,
      verifiedObjectBytes = 0;
    let failed = false,
      failure: unknown;
    const worker = async () => {
      try {
        while (!failed && cursor < numbers.length) {
          signal.throwIfAborted();
          const n = numbers[cursor++]!;
          const key = `${this.volumePrefix(actor.volumeId)}${this.packPrefix(actor)}${String(n).padStart(6, "0")}`;
          const bytes = await this.config.store.size(key, { signal });
          signal.throwIfAborted();
          if (
            bytes === null ||
            !Number.isSafeInteger(bytes) ||
            bytes < 1 ||
            bytes > MAX_CAPTURE_PACK_BYTES
          )
            throw new CaptureProgressRejected(
              "capture pack is missing or outside the size bound",
            );
          verifiedObjectBytes += bytes;
          if (
            !Number.isSafeInteger(verifiedObjectBytes) ||
            verifiedObjectBytes > this.limits.maxObjectBytes
          )
            throw new VolumeQuotaExceeded(
              "maxObjectBytes",
              verifiedObjectBytes,
              this.limits.maxObjectBytes,
            );
          measured.set(n, bytes);
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          controller.abort(error);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, numbers.length) }, worker),
    );
    if (failed) throw failure;
    signal.throwIfAborted();
    const verifiedBytes = (memo?.verifiedBytes ?? 0) + verifiedObjectBytes;
    // An unseen prefix has no inventory proof. Charge its worst allowed pack size;
    // this may reject a large pending prefix even when its real bytes would fit.
    const unknownPacks =
      memo?.unknownPacks ?? progress.uploaded_packs - numbers.length;
    const pendingObjectBytes =
      verifiedBytes + unknownPacks * MAX_CAPTURE_PACK_BYTES;
    const { volume } = await check();
    const total = volume.storedBytes + pendingObjectBytes;
    if (!Number.isSafeInteger(total) || total > this.limits.maxObjectBytes)
      throw new VolumeQuotaExceeded(
        "maxObjectBytes",
        total,
        this.limits.maxObjectBytes,
      );
    const packs = new Map(memo?.packs);
    for (const [n, bytes] of measured) {
      if (packs.has(n))
        throw new CaptureProgressRejected("capture repeated a verified pack");
      packs.set(n, bytes);
    }
    if (packs.size + unknownPacks !== progress.uploaded_packs)
      throw new CaptureProgressRejected(
        "capture pack count does not match verified progress",
      );
    const slotsUrl = await this.publishSlots(actor, {
      nextPack: progress.next_pack,
      drainId: options.drainId,
      signal: options.signal,
      expectedCapture: {
        bootId: progress.boot_id,
        epoch: progress.epoch,
        baseSeq: progress.base_seq,
        pendingObjectBytes,
      },
    });
    options.signal?.throwIfAborted();
    this.captures.set(progress, { packs, verifiedBytes, unknownPacks });
    return { slotsUrl, progress, verifiedObjectBytes };
  }

  /** The restore plan: every entry, every needed chunk location, one GET URL per pack. */
  async plan(attachment: AttachmentRow): Promise<RestorePlan> {
    const prefix = this.volumePrefix(attachment.volumeId);
    const { seq, entries, chunks } = await this.repo.planSnapshot(
      attachment.volumeId,
    );
    const packs: Record<string, string> = {};
    for (const location of Object.values(chunks)) {
      const key = location[0];
      if (!(key in packs))
        packs[key] = await this.config.store.presignGet(
          `${prefix}${key}`,
          this.ttl,
        );
    }
    return {
      volume: attachment.volumeId,
      attachment: attachment.id,
      seq,
      entries,
      chunks,
      packs,
    };
  }

  /** Put the plan and the slots in the bucket and hand back one GET URL for each (what the sandbox-side attach command downloads). */
  async publishAttachFiles(attachment: AttachmentRow): Promise<AttachFiles> {
    const prefix = this.volumePrefix(attachment.volumeId);
    const plan = await this.plan(attachment);
    const planJson = Buffer.from(JSON.stringify(plan), "utf8");
    const planKey = `${prefix}att/${attachment.id}/plan-${id(4)}`;
    await this.config.store.put(
      planKey,
      zstdCompressSync(planJson),
      "application/zstd",
    );
    const slotsUrl = await this.publishSlots(attachment);
    return {
      planUrl: await this.config.store.presignGet(planKey, 900),
      slotsUrl,
      planBytes: planJson.length,
      planSeq: plan.seq,
    };
  }

  async publishSlots(
    attachment: AttachmentRow,
    options: {
      nextPack?: number;
      drainId?: string;
      expectedCapture?: ExpectedCapture;
      signal?: AbortSignal;
    } = {},
  ): Promise<string> {
    if (options.signal !== undefined)
      AbortSignal.prototype.throwIfAborted.call(options.signal);
    // A HEAD-verified actor must never drift to a newly fetched boot/epoch.
    const fresh = options.expectedCapture
      ? attachment
      : ((await this.repo.getAttachment(attachment.id)) ?? attachment);
    const slots = await this.issueSlots(fresh, options);
    options.signal?.throwIfAborted();
    const key = `${this.volumePrefix(attachment.volumeId)}att/${attachment.id}/slots-${fresh.epoch}-${id(4)}`;
    await this.config.store.put(
      key,
      Buffer.from(JSON.stringify(slots), "utf8"),
      "application/json",
    );
    options.signal?.throwIfAborted();
    const url = await this.config.store.presignGet(key, 900);
    options.signal?.throwIfAborted();
    return url;
  }

  /** Apply every manifest the sandbox has uploaded past the current head, in order. Stops at the first gap or rejection. */
  async applyWal(
    attachmentId: string,
    options: { maxCommits?: number; drainId?: string } = {},
  ): Promise<ApplyWalResult> {
    if (
      options.maxCommits !== undefined &&
      (!Number.isSafeInteger(options.maxCommits) || options.maxCommits < 1)
    )
      throw new Error("maxCommits must be a positive safe integer");
    const attachment = await this.repo.getAttachment(attachmentId);
    if (!attachment)
      throw new Error(`attachment ${attachmentId} does not exist`);
    if (!attachmentCanWrite(attachment, options.drainId))
      throw new Error(
        `attachment ${attachmentId} is not active (superseded or rejected)`,
      );
    return this.withLock(attachment.volumeId, () =>
      this.applyWalLocked(attachment, options.maxCommits, options.drainId),
    );
  }

  private async applyWalLocked(
    attachment: AttachmentRow,
    maxCommits = Number.POSITIVE_INFINITY,
    drainId?: string,
  ): Promise<ApplyWalResult> {
    const prefix = this.volumePrefix(attachment.volumeId);
    const result: ApplyWalResult = {
      applied: 0,
      entries: [],
      rejected: null,
      hasMore: false,
    };
    let processed = 0;
    for (;;) {
      // Replayed commits count as work too; another host winning must not bypass the budget.
      if (processed >= maxCommits) {
        result.hasMore = true;
        break;
      }
      const head = await this.repo.head(attachment.volumeId);
      const seq = head + 1;
      const ownKey = `${this.manifestPrefix(attachment)}${seq}`;
      const raw = await this.measured("manifest_get", () =>
        this.config.store.get(`${prefix}${ownKey}`, {
          maxBytes: MAX_MANIFEST_OBJECT_BYTES,
        }),
      );
      if (raw === null) break;
      processed++;
      try {
        const parsed = this.measuredParse(raw);
        const wanted = new Set<string>(
          Object.keys(parsed.manifest.chunks ?? {}),
        );
        if (Array.isArray(parsed.manifest.upserts))
          for (const entry of parsed.manifest.upserts) {
            if (entry && Array.isArray(entry.c))
              for (const pair of entry.c) {
                if (Array.isArray(pair) && typeof pair[0] === "string")
                  wanted.add(pair[0]);
              }
          }
        const known = await this.measured("chunk_lookup", () =>
          this.repo.chunkLocations(
            attachment.volumeId,
            [...wanted].filter((id) => /^[0-9a-f]{64}$/.test(id)),
          ),
        );
        const heads = {
          count: 0,
          sumMs: 0,
          maxInFlight: 0,
          missing: 0,
          failed: 0,
        };
        let inFlight = 0,
          firstHead = 0,
          lastHead = 0;
        const packSize = this.config.onMetric
          ? async (key: string) => {
              const started = performance.now();
              if (heads.count++ === 0) firstHead = started;
              heads.maxInFlight = Math.max(heads.maxInFlight, ++inFlight);
              try {
                const size = await this.config.store.size(`${prefix}${key}`);
                if (size === null) heads.missing++;
                return size;
              } catch (error) {
                heads.failed++;
                throw error;
              } finally {
                lastHead = performance.now();
                heads.sumMs += lastHead - started;
                inFlight--;
              }
            }
          : (key: string) => this.config.store.size(`${prefix}${key}`);
        const validated = await this.measured("manifest_validate", () =>
          validateManifest(parsed.manifest, {
            volumeId: attachment.volumeId,
            attachmentId: attachment.id,
            head,
            bootId: attachment.bootId,
            slotsUntilPack: attachment.slotsUntilPack,
            slotsUntilSeq: attachment.slotsUntilSeq,
            packPrefix: this.packPrefix(attachment),
            ownKey,
            rawLength: parsed.rawLength,
            inlineRange: parsed.inlineRange,
            chunkKnown: async (chunkId) => Object.hasOwn(known, chunkId),
            chunkLength: async (chunkId) => known[chunkId]?.[3] ?? null,
            packSize,
          }),
        ).finally(() => {
          if (this.config.onMetric)
            this.emitMetric({
              phase: "pack_heads",
              ...heads,
              wallMs: heads.count ? lastHead - firstHead : 0,
            });
        });
        const applied = await this.measured("manifest_apply", () =>
          this.repo.applyManifest(
            attachment.volumeId,
            validated.manifest,
            validated.newChunks,
            validated.packSizes,
            {
              epoch: attachment.epoch,
              manifestKey: ownKey,
              manifestHash: createHash("sha256").update(raw).digest("hex"),
              drainId,
            },
          ),
        );
        if (!applied) continue;
        result.applied += 1;
        const m = validated.manifest;
        result.entries.push({
          seq,
          trigger: m.trigger,
          upserts: m.upserts?.length ?? 0,
          deletes: m.deletes?.length ?? 0,
          tsMs: m.ts_ms,
          unstable: m.unstable?.length ?? 0,
        });
      } catch (error) {
        // Transport/DB errors must remain retryable; they are not malformed user data.
        if (!(error instanceof ManifestRejected)) throw error;
        const reason = error.message;
        await this.repo.recordReject({
          id: `r${id(6)}`,
          volumeId: attachment.volumeId,
          attachmentId: attachment.id,
          seq,
          reason,
        });
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
  async beginRebase(
    attachmentId: string,
    options: { drainId?: string } = {},
  ): Promise<{ attachment: AttachmentRow; slotsUrl: string; head: number }> {
    const fresh = await this.repo.advanceAttachmentEpoch(attachmentId, options);
    const slotsUrl = await this.publishSlots(fresh, options);
    return {
      attachment: fresh,
      slotsUrl,
      head: await this.repo.head(fresh.volumeId),
    };
  }

  /** A bounded, byte-verified repair. Unknown external results remain registered and charged. */
  async repairPack(
    volumeId: string,
    packKey: string,
    options: { reservationKey?: string } = {},
  ): Promise<string> {
    const reservation = await this.repo.reserveRepair(
      volumeId,
      packKey,
      options.reservationKey ?? `${packKey}.r${id(12)}`,
      options.reservationKey !== undefined,
    );
    if (reservation.state === "complete") return reservation.packKey;
    return boundedRepair(async () => {
      const prefix = this.volumePrefix(volumeId);
      // The source body leaves scope before target GET; no second retained 64 MiB body.
      const digest = async (key: string): Promise<string | null> => {
        const bytes = await this.config.store.get(`${prefix}${key}`, {
          maxBytes: reservation.sizeBytes,
        });
        if (bytes === null) return null;
        if (bytes.length !== reservation.sizeBytes)
          throw new Error(
            "repair object length differs from reservation; reservation retained",
          );
        return createHash("sha256").update(bytes).digest("hex");
      };
      const sourceHash = await digest(packKey);
      if (sourceHash === null)
        throw new Error("repair source is missing; reservation retained");
      let targetHash = await digest(reservation.packKey);
      if (targetHash === null) {
        await this.config.store.copy(
          `${prefix}${packKey}`,
          `${prefix}${reservation.packKey}`,
        );
        targetHash = await digest(reservation.packKey);
      }
      if (targetHash === null || targetHash !== sourceHash)
        throw new Error(
          "repair object does not match complete source bytes; reservation retained",
        );
      await this.repo.finishRepair(reservation);
      return reservation.packKey;
    });
  }

  /** Make the state at `seq` the new head (point-in-time recovery). Returns the new head. */
  async rollback(volumeId: string, seq: number): Promise<number> {
    return this.withLock(volumeId, () => this.repo.rollback(volumeId, seq));
  }

  async chunkLocations(
    volumeId: string,
    ids: Iterable<string>,
  ): Promise<Record<string, ChunkLocation>> {
    return this.repo.chunkLocations(volumeId, ids);
  }

  private async withLock<T>(
    volumeId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
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
