import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  sandboxVolumes,
  sandboxVolumeAttachments,
  sandboxVolumeDrains,
  sandboxVolumeExecutionPermits,
  sandboxVolumeRecoveries,
} from "@sourceweft/db/schema";
import {
  VolumeConflict,
  type VolumeDatabase,
  type AttachmentRow,
} from "./repository";
type Tx = Parameters<Parameters<VolumeDatabase["transaction"]>[0]>[0];
export type InstanceIdentity = {
  sandboxId: string;
  bootId: string;
  supervisorNonce: string;
};
export type DrainRequest = InstanceIdentity & {
  operationId: string;
  reason: string;
};
export type SupervisorStopProof = InstanceIdentity & {
  drainId: string;
  stopped: true;
};
export type SupervisorRecoveryProof = {
  sandboxId: string;
  bootId: string;
  previousSupervisorNonce: string;
  supervisorNonce: string;
  journalDigest: string;
  allOldNamespacesExited: true;
  launchGateClosed: true;
};
export type ProviderAbsenceEvidence = {
  sandboxId: string;
  provider: string;
  providerScopeFingerprint: string;
  requestId: string;
  observedAt: string;
  authoritativeMissing: true;
};
export type RecoveryCandidatesOptions = {
  limit?: number;
  afterAttachmentId?: string;
  staleAfterMs?: number;
};

function sameInstance(actor: AttachmentRow, input: InstanceIdentity) {
  if (
    !input.sandboxId ||
    !input.bootId ||
    !input.supervisorNonce ||
    actor.sandboxId !== input.sandboxId ||
    actor.bootId !== input.bootId ||
    actor.supervisorNonce !== input.supervisorNonce
  )
    throw new VolumeConflict("supervisor instance identity changed");
}
export type VolumeWriterKind = "external" | "supervised";
export type PermitRelease =
  | { outcome: "not_started" }
  | { outcome: "persisted"; confirmedSeq: number }
  | { outcome: "stopped"; drainId: string }
  | { outcome: "external_settled"; drainId: string; settled: true };

export class VolumeExecutionQueued extends Error {
  override readonly name = "VolumeExecutionQueued";
  readonly code = "VOLUME_EXECUTION_QUEUED";
  readonly retryAfterMs = 100;
  constructor() {
    super("another volume operation is awaiting its durable barrier");
  }
}

export class VolumeLifecycle {
  constructor(private readonly db: VolumeDatabase) {}
  private async locked<T>(
    attachmentId: string,
    fn: (tx: Tx, actor: AttachmentRow, head: number) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const initial = (
        await tx
          .select()
          .from(sandboxVolumeAttachments)
          .where(eq(sandboxVolumeAttachments.id, attachmentId))
      )[0];
      if (!initial) throw new VolumeConflict("attachment does not exist");
      const volume = (
        await tx
          .select()
          .from(sandboxVolumes)
          .where(eq(sandboxVolumes.id, initial.volumeId))
          .for("update")
      )[0];
      if (!volume) throw new VolumeConflict("volume does not exist");
      const actor = (
        await tx
          .select()
          .from(sandboxVolumeAttachments)
          .where(eq(sandboxVolumeAttachments.id, attachmentId))
      )[0];
      if (!actor) throw new VolumeConflict("attachment does not exist");
      return fn(tx, actor, volume.headSeq);
    });
  }
  private async unresolvedOperations(tx: Tx, attachmentId: string) {
    const rows = await tx
      .select()
      .from(sandboxVolumeExecutionPermits)
      .where(
        and(
          eq(sandboxVolumeExecutionPermits.attachmentId, attachmentId),
          eq(sandboxVolumeExecutionPermits.status, "active"),
        ),
      );
    return rows.map((row) => ({
      permitId: row.id,
      operationId: row.operationId,
      writerKind: row.writerKind,
      outcome: row.startedAt ? ("unknown" as const) : ("not_started" as const),
    }));
  }

  private async assertDrainController(
    tx: Tx,
    actor: AttachmentRow,
    proof: SupervisorStopProof,
  ): Promise<void> {
    const drain = (
      await tx
        .select()
        .from(sandboxVolumeDrains)
        .where(
          and(
            eq(sandboxVolumeDrains.id, proof.drainId),
            eq(sandboxVolumeDrains.attachmentId, actor.id),
          ),
        )
    )[0];
    const expected = drain?.recoveryControllerNonce ?? actor.supervisorNonce;
    if (
      actor.sandboxId !== proof.sandboxId ||
      actor.bootId !== proof.bootId ||
      !proof.supervisorNonce ||
      proof.supervisorNonce !== expected
    )
      throw new VolumeConflict(
        "supervisor recovery controller identity changed",
      );
  }

  /** Host-only recovery of a preserved local filesystem after the old controller and all its namespaces exited. */
  async recoverSupervisor(
    attachmentId: string,
    input: { operationId: string; proof: SupervisorRecoveryProof },
  ) {
    const proof = input.proof;
    if (
      !input.operationId ||
      input.operationId.length > 256 ||
      !proof ||
      !proof.sandboxId ||
      !proof.bootId ||
      !/^[-_A-Za-z0-9]{16,128}$/.test(proof.previousSupervisorNonce) ||
      !/^[-_A-Za-z0-9]{16,128}$/.test(proof.supervisorNonce) ||
      proof.previousSupervisorNonce === proof.supervisorNonce ||
      !/^[0-9a-f]{64}$/.test(proof.journalDigest) ||
      proof.allOldNamespacesExited !== true ||
      proof.launchGateClosed !== true
    )
      throw new Error("invalid supervisor recovery proof");
    return this.locked(attachmentId, async (tx, actor, head) => {
      if (
        actor.sandboxId !== proof.sandboxId ||
        actor.bootId !== proof.bootId ||
        !actor.supervisorNonce
      )
        throw new VolumeConflict(
          "supervisor recovery must preserve the same sandbox and boot",
        );
      if (!["active", "quarantined", "draining"].includes(actor.status))
        throw new VolumeConflict("attachment is no longer recoverable");
      let drain = (
        await tx
          .select()
          .from(sandboxVolumeDrains)
          .where(eq(sandboxVolumeDrains.attachmentId, attachmentId))
      )[0];
      const controller =
        drain?.recoveryControllerNonce ?? actor.supervisorNonce;
      const replay = (
        await tx
          .select()
          .from(sandboxVolumeRecoveries)
          .where(
            and(
              eq(sandboxVolumeRecoveries.attachmentId, attachmentId),
              eq(sandboxVolumeRecoveries.kind, "supervisor"),
              eq(
                sandboxVolumeRecoveries.supervisorNonce,
                proof.supervisorNonce,
              ),
            ),
          )
      )[0];
      if (replay) {
        if (
          !drain ||
          controller !== proof.supervisorNonce ||
          replay.previousSupervisorNonce !== proof.previousSupervisorNonce ||
          replay.journalDigest !== proof.journalDigest
        )
          throw new VolumeConflict(
            "supervisor recovery proof is stale or conflicts with recorded evidence",
          );
        return {
          ...drain,
          drainId: drain.id,
          head,
          recoveryId: replay.id,
          unresolvedOperations: replay.unresolvedOperations,
        };
      }
      if (controller !== proof.previousSupervisorNonce)
        throw new VolumeConflict(
          "supervisor recovery predecessor does not match current controller",
        );
      if (!drain) {
        drain = (
          await tx
            .insert(sandboxVolumeDrains)
            .values({
              id: randomUUID(),
              volumeId: actor.volumeId,
              attachmentId,
              operationId: input.operationId,
              sandboxId: proof.sandboxId,
              bootId: proof.bootId,
              supervisorNonce: actor.supervisorNonce,
              reason: "supervisor_restart",
            })
            .returning()
        )[0]!;
      } else if (
        actor.status !== "draining" ||
        actor.drainId !== drain.id ||
        drain.status !== "draining"
      )
        throw new VolumeConflict("supervisor recovery drain fence changed");
      const unresolvedOperations = await this.unresolvedOperations(
        tx,
        attachmentId,
      );
      const recovery = (
        await tx
          .insert(sandboxVolumeRecoveries)
          .values({
            id: randomUUID(),
            volumeId: actor.volumeId,
            attachmentId,
            drainId: drain.id,
            kind: "supervisor",
            operationId: input.operationId,
            previousSupervisorNonce: proof.previousSupervisorNonce,
            supervisorNonce: proof.supervisorNonce,
            journalDigest: proof.journalDigest,
            confirmedSeq: head,
            unresolvedOperations,
            evidence: {
              sandboxId: proof.sandboxId,
              bootId: proof.bootId,
              allOldNamespacesExited: true,
              launchGateClosed: true,
            },
          })
          .returning()
      )[0]!;
      await tx
        .update(sandboxVolumeAttachments)
        .set({ status: "draining", drainId: drain.id })
        .where(eq(sandboxVolumeAttachments.id, attachmentId));
      const updated = (
        await tx
          .update(sandboxVolumeDrains)
          .set({
            recoveryControllerNonce: proof.supervisorNonce,
            stoppedAt: sql`now()`,
            confirmedSeq: null,
          })
          .where(eq(sandboxVolumeDrains.id, drain.id))
          .returning()
      )[0]!;
      return {
        ...updated,
        drainId: updated.id,
        head,
        recoveryId: recovery.id,
        unresolvedOperations,
      };
    });
  }

  /** Audit only: absence cannot prove unuploaded bytes were recovered. This does not release or rebind anything. */
  async auditProviderAbsence(
    attachmentId: string,
    input: { operationId: string; evidence: ProviderAbsenceEvidence },
  ) {
    const evidence = input.evidence;
    if (
      !input.operationId ||
      input.operationId.length > 256 ||
      !evidence ||
      evidence.authoritativeMissing !== true ||
      !evidence.sandboxId ||
      !/^[-_a-z0-9]{1,64}$/.test(evidence.provider) ||
      !/^[0-9a-f]{64}$/.test(evidence.providerScopeFingerprint) ||
      !/^[-_a-zA-Z0-9:.]{1,256}$/.test(evidence.requestId) ||
      !Number.isFinite(Date.parse(evidence.observedAt))
    )
      throw new Error("invalid provider absence evidence");
    return this.locked(attachmentId, async (tx, actor, head) => {
      if (actor.sandboxId !== evidence.sandboxId)
        throw new VolumeConflict(
          "provider evidence belongs to a different sandbox",
        );
      const existing = (
        await tx
          .select()
          .from(sandboxVolumeRecoveries)
          .where(
            and(
              eq(sandboxVolumeRecoveries.attachmentId, attachmentId),
              eq(sandboxVolumeRecoveries.kind, "provider_absent"),
              eq(sandboxVolumeRecoveries.operationId, input.operationId),
            ),
          )
      )[0];
      if (existing) {
        if (
          JSON.stringify(existing.evidence) !== JSON.stringify({ ...evidence })
        ) {
          for (const [key, value] of Object.entries(evidence))
            if (existing.evidence[key] !== value)
              throw new VolumeConflict(
                "provider absence audit conflicts with earlier evidence",
              );
        }
        return existing;
      }
      return (
        await tx
          .insert(sandboxVolumeRecoveries)
          .values({
            id: randomUUID(),
            volumeId: actor.volumeId,
            attachmentId,
            kind: "provider_absent",
            operationId: input.operationId,
            confirmedSeq: head,
            unresolvedOperations: await this.unresolvedOperations(
              tx,
              attachmentId,
            ),
            evidence: { ...evidence },
          })
          .returning()
      )[0]!;
    });
  }

  /** Read-only candidates. Age selects probes, never permission to release or kill a workload. */
  async listRecoveryCandidates(options: RecoveryCandidatesOptions = {}) {
    const limit = options.limit ?? 40,
      staleAfterMs = options.staleAfterMs ?? 60_000;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(staleAfterMs) ||
      staleAfterMs < 0 ||
      staleAfterMs > 7 * 24 * 60 * 60 * 1000 ||
      (options.afterAttachmentId !== undefined &&
        !/^[A-Za-z0-9_-]{1,128}$/.test(options.afterAttachmentId))
    )
      throw new Error("invalid recovery candidate bounds");
    const rows = await this.db.execute<{
      attachmentId: string;
      volumeId: string;
      sandboxId: string | null;
      bootId: string | null;
      supervisorNonce: string | null;
      drainId: string | null;
      recoveryControllerNonce: string | null;
      status: string;
      confirmedSeq: number;
      teamId: string;
      workspaceId: string;
      threadId: string;
      activePermits: number;
    }>(sql`
      select a.id as "attachmentId",a.volume_id as "volumeId",a.sandbox_id as "sandboxId",a.boot_id as "bootId",a.supervisor_nonce as "supervisorNonce",a.drain_id as "drainId",d.recovery_controller_nonce as "recoveryControllerNonce",a.status,a.last_applied_seq::float8 as "confirmedSeq",v.team_id as "teamId",v.workspace_id as "workspaceId",v.thread_id as "threadId",
      (select count(*)::int from sandbox_volume_execution_permits p where p.attachment_id=a.id and p.status='active') as "activePermits"
      from sandbox_volume_attachments a join sandbox_volumes v on v.id=a.volume_id left join sandbox_volume_drains d on d.id=a.drain_id
      where a.status in ('active','quarantined','draining') and ${options.afterAttachmentId ? sql`a.id>${options.afterAttachmentId}` : sql`true`} and (
        a.status in ('quarantined','draining') or a.control_expires_at<=now()
        or exists(select 1 from sandbox_volume_execution_permits p where p.attachment_id=a.id and p.status='active' and p.created_at<=now()-(${staleAfterMs}*interval '1 millisecond')))
      order by a.id limit ${limit}`);
    return rows.rows;
  }

  async bindSupervisorIdentity(
    attachmentId: string,
    nonce: string,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
      throw new Error("invalid supervisor nonce");
    await this.locked(attachmentId, async (tx, actor) => {
      if (
        actor.status !== "active" ||
        (actor.supervisorNonce !== null && actor.supervisorNonce !== nonce)
      )
        throw new VolumeConflict(
          "supervisor identity cannot be replaced without recovery",
        );
      await tx
        .update(sandboxVolumeAttachments)
        .set({ supervisorNonce: nonce })
        .where(eq(sandboxVolumeAttachments.id, attachmentId));
    });
  }
  async acquireExecutionPermit(
    attachmentId: string,
    input: InstanceIdentity & {
      operationId: string;
      writerKind?: VolumeWriterKind;
    },
  ) {
    if (!input.operationId || input.operationId.length > 256)
      throw new Error("invalid execution operation identity");
    return this.locked(attachmentId, async (tx, actor) => {
      sameInstance(actor, input);
      const writerKind = input.writerKind ?? "external";
      if (writerKind !== "external" && writerKind !== "supervised")
        throw new Error("invalid writer kind");
      if (actor.status !== "active")
        throw new VolumeConflict("attachment admission is closed");
      const existing = (
        await tx
          .select()
          .from(sandboxVolumeExecutionPermits)
          .where(
            and(
              eq(sandboxVolumeExecutionPermits.attachmentId, attachmentId),
              eq(sandboxVolumeExecutionPermits.operationId, input.operationId),
            ),
          )
      )[0];
      if (existing) {
        if (existing.writerKind !== writerKind)
          throw new VolumeConflict(
            "execution writer kind cannot change on retry",
          );
        if (existing.status !== "active")
          throw new VolumeConflict(
            "execution operation already released; do not replay",
          );
        return { ...existing, reused: true };
      }
      const active = (
        await tx
          .select({ id: sandboxVolumeExecutionPermits.id })
          .from(sandboxVolumeExecutionPermits)
          .where(
            and(
              eq(sandboxVolumeExecutionPermits.volumeId, actor.volumeId),
              eq(sandboxVolumeExecutionPermits.status, "active"),
            ),
          )
          .limit(1)
      )[0];
      if (active) throw new VolumeExecutionQueued();
      const inserted = (
        await tx
          .insert(sandboxVolumeExecutionPermits)
          .values({
            id: randomUUID(),
            volumeId: actor.volumeId,
            attachmentId,
            operationId: input.operationId,
            writerKind,
          })
          .returning()
      )[0]!;
      return { ...inserted, reused: false };
    });
  }
  /** Mark before dispatch. False means this operation may already have executed; never replay it. */
  async markExecutionStarted(
    attachmentId: string,
    permitId: string,
  ): Promise<boolean> {
    return this.locked(attachmentId, async (tx, actor) => {
      if (actor.status !== "active")
        throw new VolumeConflict("attachment admission is closed");
      const permit = (
        await tx
          .select()
          .from(sandboxVolumeExecutionPermits)
          .where(
            and(
              eq(sandboxVolumeExecutionPermits.id, permitId),
              eq(sandboxVolumeExecutionPermits.attachmentId, attachmentId),
            ),
          )
      )[0];
      if (!permit || permit.status !== "active")
        throw new VolumeConflict("execution permit is not active");
      if (permit.startedAt) return false;
      await tx
        .update(sandboxVolumeExecutionPermits)
        .set({ startedAt: sql`now()` })
        .where(eq(sandboxVolumeExecutionPermits.id, permitId));
      return true;
    });
  }

  async releaseExecutionPermit(
    attachmentId: string,
    permitId: string,
    result: PermitRelease,
  ): Promise<void> {
    await this.locked(attachmentId, async (tx, actor) => {
      const permit = (
        await tx
          .select()
          .from(sandboxVolumeExecutionPermits)
          .where(
            and(
              eq(sandboxVolumeExecutionPermits.id, permitId),
              eq(sandboxVolumeExecutionPermits.attachmentId, attachmentId),
            ),
          )
      )[0];
      if (!permit)
        throw new VolumeConflict(
          "execution permit does not belong to attachment",
        );
      if (permit.status === "released") return;
      if (result.outcome === "not_started") {
        if (permit.startedAt)
          throw new VolumeConflict(
            "execution was dispatched; unknown result cannot be released as not started",
          );
      } else if (result.outcome === "persisted") {
        if (
          actor.status !== "active" ||
          !Number.isSafeInteger(result.confirmedSeq) ||
          result.confirmedSeq < actor.baseSeq ||
          result.confirmedSeq > actor.lastAppliedSeq
        )
          throw new VolumeConflict(
            "execution has no confirmed persistence barrier",
          );
      } else if (result.outcome === "stopped") {
        if (permit.writerKind !== "supervised")
          throw new VolumeConflict(
            "namespace stop proof cannot release an external writer",
          );
        const drain = (
          await tx
            .select()
            .from(sandboxVolumeDrains)
            .where(
              and(
                eq(sandboxVolumeDrains.id, result.drainId),
                eq(sandboxVolumeDrains.attachmentId, attachmentId),
              ),
            )
        )[0];
        if (!drain?.stoppedAt || actor.drainId !== result.drainId)
          throw new VolumeConflict(
            "execution has no confirmed supervisor stop proof",
          );
      } else if (result.outcome === "external_settled") {
        if (
          permit.writerKind !== "external" ||
          result.settled !== true ||
          actor.status !== "draining" ||
          actor.drainId !== result.drainId
        )
          throw new VolumeConflict(
            "external I/O settlement does not match the current drain",
          );
        // Host-only proof that the provider-side I/O has actually ended, not merely timed out.
        await tx
          .update(sandboxVolumeDrains)
          .set({ confirmedSeq: null })
          .where(eq(sandboxVolumeDrains.id, result.drainId));
      } else throw new Error("invalid execution release outcome");
      await tx
        .update(sandboxVolumeExecutionPermits)
        .set({ status: "released", releasedAt: sql`now()` })
        .where(eq(sandboxVolumeExecutionPermits.id, permitId));
    });
  }

  async beginDrain(attachmentId: string, input: DrainRequest) {
    if (
      !input.operationId ||
      input.operationId.length > 256 ||
      !input.reason ||
      input.reason.length > 512
    )
      throw new Error("invalid drain operation");
    return this.locked(attachmentId, async (tx, actor, head) => {
      sameInstance(actor, input);
      let drain = (
        await tx
          .select()
          .from(sandboxVolumeDrains)
          .where(eq(sandboxVolumeDrains.attachmentId, attachmentId))
      )[0];
      if (!drain) {
        if (actor.status !== "active" && actor.status !== "quarantined")
          throw new VolumeConflict("attachment cannot enter drain");
        drain = (
          await tx
            .insert(sandboxVolumeDrains)
            .values({
              id: randomUUID(),
              volumeId: actor.volumeId,
              attachmentId,
              ...input,
            })
            .returning()
        )[0]!;
        await tx
          .update(sandboxVolumeAttachments)
          .set({ status: "draining", drainId: drain.id })
          .where(eq(sandboxVolumeAttachments.id, attachmentId));
      } else if (
        actor.drainId !== drain.id ||
        (actor.status !== "draining" && actor.status !== "retired")
      )
        throw new VolumeConflict("drain fence changed");
      const permits = await tx
        .select({
          id: sandboxVolumeExecutionPermits.id,
          operationId: sandboxVolumeExecutionPermits.operationId,
          writerKind: sandboxVolumeExecutionPermits.writerKind,
        })
        .from(sandboxVolumeExecutionPermits)
        .where(
          and(
            eq(sandboxVolumeExecutionPermits.attachmentId, attachmentId),
            eq(sandboxVolumeExecutionPermits.status, "active"),
          ),
        );
      return { ...drain, drainId: drain.id, head, activePermits: permits };
    });
  }
  /** Persist stop-before-checkpoint ordering; this proof must come from the isolated supervisor. */
  async recordSupervisorStop(
    attachmentId: string,
    proof: SupervisorStopProof,
  ): Promise<void> {
    await this.locked(attachmentId, async (tx, actor) => {
      await this.assertDrainController(tx, actor, proof);
      if (
        proof.stopped !== true ||
        actor.drainId !== proof.drainId ||
        (actor.status !== "draining" && actor.status !== "retired")
      )
        throw new VolumeConflict("supervisor stop proof does not match drain");
      const rows = await tx
        .update(sandboxVolumeDrains)
        .set({
          stoppedAt: sql`coalesce(${sandboxVolumeDrains.stoppedAt},now())`,
        })
        .where(
          and(
            eq(sandboxVolumeDrains.id, proof.drainId),
            eq(sandboxVolumeDrains.attachmentId, attachmentId),
          ),
        )
        .returning();
      if (!rows.length) throw new VolumeConflict("drain does not exist");
    });
  }

  /** Internal trusted-host API: stopProof must come from the isolated supervisor, never a user response. */
  async finishDrain(
    attachmentId: string,
    input: {
      drainId: string;
      confirmedSeq: number;
      stopProof: SupervisorStopProof;
    },
  ) {
    return this.locked(attachmentId, async (tx, actor, head) => {
      await this.assertDrainController(tx, actor, input.stopProof);
      if (
        input.stopProof.stopped !== true ||
        input.stopProof.drainId !== input.drainId ||
        actor.drainId !== input.drainId
      )
        throw new VolumeConflict("supervisor stop proof does not match drain");
      const drain = (
        await tx
          .select()
          .from(sandboxVolumeDrains)
          .where(
            and(
              eq(sandboxVolumeDrains.id, input.drainId),
              eq(sandboxVolumeDrains.attachmentId, attachmentId),
            ),
          )
      )[0];
      if (
        !drain ||
        !drain.stoppedAt ||
        !Number.isSafeInteger(input.confirmedSeq) ||
        drain.confirmedSeq !== input.confirmedSeq
      )
        throw new VolumeConflict("drain has no matching confirmed checkpoint");
      if (drain.status === "retired") return { ...drain, drainId: drain.id };
      if (
        actor.status !== "draining" ||
        head !== input.confirmedSeq ||
        actor.lastAppliedSeq !== input.confirmedSeq
      )
        throw new VolumeConflict(
          "drain checkpoint is not the current confirmed head",
        );
      const external = await tx
        .select({ id: sandboxVolumeExecutionPermits.id })
        .from(sandboxVolumeExecutionPermits)
        .where(
          and(
            eq(sandboxVolumeExecutionPermits.attachmentId, attachmentId),
            eq(sandboxVolumeExecutionPermits.status, "active"),
            eq(sandboxVolumeExecutionPermits.writerKind, "external"),
          ),
        )
        .limit(1);
      if (external.length)
        throw new VolumeConflict(
          "external writer has not been confirmed stopped",
        );
      await tx
        .update(sandboxVolumeExecutionPermits)
        .set({ status: "released", releasedAt: sql`now()` })
        .where(
          and(
            eq(sandboxVolumeExecutionPermits.attachmentId, attachmentId),
            eq(sandboxVolumeExecutionPermits.status, "active"),
          ),
        );
      await tx
        .update(sandboxVolumeAttachments)
        .set({
          status: "retired",
          controlTokenHash: null,
          controlExpiresAt: null,
        })
        .where(eq(sandboxVolumeAttachments.id, attachmentId));
      const rows = await tx
        .update(sandboxVolumeDrains)
        .set({ status: "retired", retiredAt: sql`now()` })
        .where(eq(sandboxVolumeDrains.id, drain.id))
        .returning();
      return { ...rows[0]!, drainId: drain.id };
    });
  }
}
