import { setTimeout as waitForPermit } from "node:timers/promises";
import {
  SandboxVolumePersistenceError,
  SandboxVolumeRecoveryPendingError,
} from "./volume-durability";
import { randomUUID } from "node:crypto";
import {
  isSandboxInstanceMissingError,
  hasSandboxPhysicalAbsenceEvidence,
  isSandboxProviderUnavailableError,
  SandboxInstanceChangedError,
  sandboxErrorDiagnostic,
} from "./errors";
import type {
  ExistingSandboxOperation,
  SandboxBridgeOperationType,
  SandboxCancellationReason,
  SandboxCancellationResult,
  SandboxExecuteResult,
  SandboxOperationStatus,
  SandboxOperationStore,
  SandboxOperationType,
  SandboxProvider,
  SandboxRef,
  SandboxRuntimeContext,
  SandboxStore,
  SandboxVolumeExecutor,
  SandboxVolumeHooks,
  SandboxVolumeScope,
  SandboxSupervisorIdentity,
} from "./types";
import {
  redactSandboxOperationRequest,
  redactSandboxSecrets,
  sandboxRequestFingerprint,
} from "./redaction";
import {
  ensureRuntimeAssets,
  type RuntimeAssetPlan,
  type RuntimeAssetResolution,
  type RuntimeAssetSessionLike,
} from "./runtime-assets";

/**
 * Skill-bundle staging wiring (docs/architecture/sandbox-skill-staging.md).
 *
 * Plans arrive as a callback so bundle bytes are only loaded when a sandbox
 * actually stages (a reused sandbox with valid stamps never re-reads them).
 * Staging is best-effort by contract: a failure leaves the sandbox fully
 * usable and merely keeps /skills denied in execute (the two-phase check in
 * SourceWeftSandboxBackend), which is exactly today's behavior.
 */
export type SandboxRuntimeAssetStaging = {
  plans: () => Promise<RuntimeAssetPlan[]>;
  commandTimeoutMs: number;
  maxOutputChars: number;
  logger?: {
    info?(message: string, meta?: Record<string, unknown>): void;
    warn?(message: string, meta?: Record<string, unknown>): void;
  };
};

/**
 * Skill staging differs from required assets in one way: its plan set may
 * GROW during the turn (`install_skill` registers the bundle it just
 * installed). `plans` therefore returns the current set every time it is
 * asked, and `hasPlans` is the cheap live answer to "is there anything to
 * stage right now" — it decides whether a /skills-referencing command is
 * deferred to staging or denied outright, so a turn that started without any
 * skill keeps today's fast denial until something is actually installed.
 * Absent → the set is treated as non-empty (the pre-registry contract).
 */
export type SandboxSkillStaging = SandboxRuntimeAssetStaging & {
  hasPlans?: () => boolean;
  /**
   * Skills the host could not plan at all (over a limit, malformed). They are
   * recorded as failed without touching the sandbox, so a command naming
   * `/skills/<name>` gets the same recoverable staging error a failed transfer
   * produces — one bad skill degrades alone instead of failing the turn.
   */
  unstageable?: () => ReadonlyArray<{
    name: string;
    version: string;
    error: string;
  }>;
};

/** What was attempted for one skill name in one provider sandbox. */
type SkillStagingAttempt = {
  /** Content identity of the attempted plan; a changed plan is restaged. */
  planKey: string;
  resolution: RuntimeAssetResolution;
};

type SkillStagingState = {
  attempts: Map<string, SkillStagingAttempt>;
  /** Serializes staging runs for this sandbox; never rejects. */
  tail: Promise<void>;
};

function skillPlanKey(plan: RuntimeAssetPlan) {
  return `${plan.version}:${plan.sha256}`;
}

const SKILL_NAME_IN_COMMAND = /\/skills\/([a-zA-Z0-9][a-zA-Z0-9._-]*)/gu;

const SANDBOX_CREATING_STALE_MS = 2 * 60 * 1000;
// How long a sibling execute waits for another call's in-flight cold start
// before giving up. Must comfortably exceed a real provider cold start (~30s
// observed) so parallel `task`/execute calls that share one thread sandbox
// don't fail with SANDBOX_CREATION_WAIT_TIMEOUT while the winner is still
// legitimately provisioning. Kept well under SANDBOX_CREATING_STALE_MS so a
// genuinely dead creation is still reclaimable as stale.
const SANDBOX_CREATING_WAIT_TIMEOUT_MS = 45_000;
const SANDBOX_CREATING_WAIT_INTERVAL_MS = 250;
export const SANDBOX_OPERATION_STALE_GRACE_MS = 30 * 1000;
export const SANDBOX_RELEASE_LEASE_GRACE_MS = 5 * 60 * 1000;
export const SANDBOX_OPERATION_STALE_RELEASED_CODE =
  "SANDBOX_OPERATION_STALE_RELEASED";
const REQUEST_FINGERPRINT_FIELD = "_sourceweftRequestFingerprint";

type BeginToolOperationResult =
  | { kind: "claimed"; operationId: string }
  | { kind: "replay"; result: Record<string, unknown> };

export type SandboxExecutionResultDisposition =
  | "accepted"
  | "instance_changed"
  | "sandbox_terminated"
  | "termination_unknown";

export function stableSandboxRequestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSandboxRequestJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${stableSandboxRequestJson(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameSandboxRequest(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  if (typeof left[REQUEST_FINGERPRINT_FIELD] === "string") {
    return left[REQUEST_FINGERPRINT_FIELD] === sandboxRequestFingerprint(right);
  }
  return stableSandboxRequestJson(left) === stableSandboxRequestJson(right);
}

function failedRetryMessage(input: {
  operationType: SandboxBridgeOperationType;
  existing: ExistingSandboxOperation;
  currentMessageId?: string;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
}) {
  const error =
    typeof input.result.error === "string"
      ? ` Last failure: ${input.result.error}`
      : "";
  const operationId = input.existing.id ?? "unknown";
  const oldMessageId = input.existing.messageId ?? "unknown";
  const currentMessageId = input.currentMessageId ?? "unknown";
  const oldCreatedAt = input.existing.createdAt?.toISOString() ?? "unknown";
  const requestFingerprint = sandboxRequestFingerprint(input.request);
  return `SANDBOX_OPERATION_FAILED_RETRY_REQUIRED: sandbox ${input.operationType} previously failed for this tool call. Use a new toolCallId or include an explicit retry nonce/request hash to retry. Previous operation: id=${operationId}, messageId=${oldMessageId}, createdAt=${oldCreatedAt}. Current messageId=${currentMessageId}. Request fingerprint=${requestFingerprint}.${error}`;
}

/** Backoff before each retry of a sandbox creation the provider refused as unavailable. */
const SANDBOX_CREATE_RETRY_DELAYS_MS = [500, 1500] as const;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveSandboxToolOperationReplay(input: {
  operationType: SandboxBridgeOperationType;
  existing: ExistingSandboxOperation | null;
  request: Record<string, unknown>;
  currentMessageId?: string;
  staleBefore?: Date;
}):
  | { kind: "proceed" }
  | { kind: "replay"; result: Record<string, unknown> }
  | { kind: "error"; message: string } {
  const existing = input.existing;
  if (!existing) {
    return { kind: "proceed" };
  }
  const sameRequest = sameSandboxRequest(
    existing.requestJsonRedacted,
    input.request,
  );
  if (!sameRequest && existing.status !== "failed") {
    return {
      kind: "error",
      message: `SANDBOX_OPERATION_REQUEST_MISMATCH: sandbox ${input.operationType} request does not match the existing operation for this tool call.`,
    };
  }
  if (existing.status === "succeeded") {
    return { kind: "replay", result: existing.resultJsonRedacted };
  }
  if (existing.status === "running") {
    if (
      input.staleBefore &&
      existing.createdAt &&
      existing.createdAt <= input.staleBefore
    ) {
      return { kind: "proceed" };
    }
    return {
      kind: "error",
      message: `SANDBOX_OPERATION_IN_PROGRESS: sandbox ${input.operationType} is already running for this tool call.`,
    };
  }
  if (sameRequest) {
    return {
      kind: "error",
      message: failedRetryMessage({
        operationType: input.operationType,
        existing,
        currentMessageId: input.currentMessageId,
        request: input.request,
        result: existing.resultJsonRedacted,
      }),
    };
  }
  return { kind: "proceed" };
}

export class SandboxManager {
  constructor(
    private readonly input: {
      provider: SandboxProvider;
      sandboxStore: SandboxStore;
      operationStore: SandboxOperationStore;
      ttlSeconds: number;
      /**
       * Longest timeout any command class can be granted — not this runtime's
       * own budget. Staleness must be swept against the maximum, or a
       * legitimately long host command gets marked failed while it is still
       * running.
       */
      maxCommandTimeoutMs: number;
      environment?: string;
      logWarn?: (message: string, meta: Record<string, unknown>) => void;
      skillStaging?: SandboxSkillStaging;
      requiredAssetStaging?: SandboxRuntimeAssetStaging;
      /** Persistent /workspace volume; absent → ephemeral sandboxes as before. */
      volume?: SandboxVolumeHooks | null;
    },
  ) {}

  /** provider sandbox id -> volume attachment id, for the sandboxes this manager attached. */
  private readonly volumeAttachments = new Map<string, string>();
  private readonly volumeAttachRuns = new Map<string, Promise<void>>();
  private readonly volumeConfirmedModes = new Map<string, "shadow" | "full">();
  private readonly volumeOperationIdentities = new Map<
    string,
    SandboxSupervisorIdentity
  >();
  private readonly lazyMountBindings = new Map<string, string>();
  private readonly lazyMountIntents = new Map<
    string,
    { bootId: string; supervisorNonce: string }
  >();
  private readonly verifiedFreezeBarriers = new Map<
    string,
    { freezeId: string; supervisorNonce: string }
  >();
  private readonly missingVolumeInstances = new Map<string, string>();

  private volumeScopeKey(context: SandboxRuntimeContext): string {
    return JSON.stringify([
      this.input.provider.id,
      context.teamId,
      context.workspaceId,
      context.threadId,
    ]);
  }

  private volumeExecutor(sandbox: SandboxRef): SandboxVolumeExecutor {
    const provider = this.input.provider;
    const execute = provider.executeSystem
      ? provider.executeSystem.bind(provider)
      : provider.execute.bind(provider);
    return {
      execute: async (command, options) => {
        const result = await execute({
          providerSandboxId: sandbox.providerSandboxId,
          command,
          timeoutMs: options.timeoutMs,
          maxOutputChars: 4 * 1024 * 1024,
        });
        return { output: result.output, exitCode: result.exitCode };
      },
    };
  }

  private volumeScope(context: SandboxRuntimeContext): SandboxVolumeScope {
    return {
      teamId: context.teamId,
      workspaceId: context.workspaceId,
      threadId: context.threadId,
    };
  }

  /** Attach the thread's volume to a (new or reused) sandbox once per manager. */
  private async ensureVolumeAttached(
    sandbox: SandboxRef,
    context: SandboxRuntimeContext,
  ): Promise<void> {
    const volume = this.input.volume;
    if (!volume || this.volumeAttachments.has(sandbox.providerSandboxId))
      return;
    let run = this.volumeAttachRuns.get(sandbox.providerSandboxId);
    if (!run) {
      const scopeKey = this.volumeScopeKey(context);
      const previousSandboxId = this.missingVolumeInstances.get(scopeKey);
      const attachInput = {
        scope: this.volumeScope(context),
        sandboxId: sandbox.providerSandboxId,
        executor: this.volumeExecutor(sandbox),
      };
      run = (async () => {
        const control = this.input.provider.volumeControl;
        if (
          !control ||
          !this.input.provider.executeSupervised ||
          volume.protectedBootstrap !== true
        ) {
          throw new Error(
            "SANDBOX_VOLUME_PROTECTED_BOOTSTRAP_REQUIRED: verify the protected provider and bootstrap contracts before creating a volume attachment.",
          );
        }
        const identity = await control.identity({
          providerSandboxId: sandbox.providerSandboxId,
        });
        if (
          identity.protocolVersion !== 1 ||
          identity.boundary !== "pid-namespace" ||
          identity.protectedControl !== true ||
          !identity.bootId ||
          !identity.supervisorNonce
        ) {
          throw new Error(
            "SANDBOX_VOLUME_SUPERVISOR_UNVERIFIED: attachment requires protected instance identity.",
          );
        }
        this.assertLazyMount(identity, sandbox.providerSandboxId);
        this.assertStableFreeze(identity);
        return previousSandboxId
          ? volume.onContainerReplaced({ ...attachInput, previousSandboxId })
          : volume.attach(attachInput);
      })()
        .then((attached) => {
          this.missingVolumeInstances.delete(scopeKey);
          this.volumeAttachments.set(
            sandbox.providerSandboxId,
            attached.attachmentId,
          );
        })
        .finally(() => this.volumeAttachRuns.delete(sandbox.providerSandboxId));
      this.volumeAttachRuns.set(sandbox.providerSandboxId, run);
    }
    await run;
  }

  /** Revalidate the database fence even when this manager cached its attachment. */
  async volumeAssertActive(
    sandbox: SandboxRef,
    context: SandboxRuntimeContext,
  ): Promise<void> {
    const volume = this.input.volume;
    const attachmentId = this.volumeAttachments.get(sandbox.providerSandboxId);
    if (this.invalidatedSandboxes.has(sandbox.providerSandboxId)) {
      throw new SandboxInstanceChangedError();
    }
    if (!volume || !attachmentId) return;
    const executor = this.volumeExecutor(sandbox);
    const control = this.input.provider.volumeControl;
    if (control) {
      this.assertLazyMount(
        await control.identity({
          providerSandboxId: sandbox.providerSandboxId,
        }),
        sandbox.providerSandboxId,
        attachmentId,
      );
    }
    try {
      await volume.assertActive({ attachmentId, executor });
    } catch (error) {
      if (
        !volume.isContainerReplacedError(error) ||
        error === null ||
        typeof error !== "object" ||
        !("commandStarted" in error) ||
        error.commandStarted !== false
      )
        throw error;
      // Only this host-owned preflight runs before the user command. Its
      // identity observation may authorize restoration; stdout never can.
      await this.reattachVolume(sandbox, context);
      const replacementId = this.volumeAttachments.get(
        sandbox.providerSandboxId,
      )!;
      await volume.assertActive({ attachmentId: replacementId, executor });
    }
  }

  /** Serialize mutations through a database permit and a supervisor-frozen durable barrier. */
  async withVolumeOperation<T>(input: {
    sandbox: SandboxRef;
    context: SandboxRuntimeContext;
    operationId: string;
    writerKind?: "external" | "supervised";
    signal?: AbortSignal;
    run: (executionId: string) => Promise<T>;
    checkpoint?: (
      result: T,
      barrier: { freezeId: string; supervisorNonce: string },
    ) => Promise<number>;
  }): Promise<T> {
    const volume = this.input.volume;
    const attachmentId = this.volumeAttachments.get(
      input.sandbox.providerSandboxId,
    );
    if (!volume) return input.run(input.operationId);
    if (!attachmentId)
      throw new Error(
        "SANDBOX_VOLUME_ATTACHMENT_REQUIRED: durable operations require a verified attachment before dispatch.",
      );
    const control = this.input.provider.volumeControl;
    if (
      !control ||
      !this.input.provider.executeSupervised ||
      !volume.acquireOperation ||
      !volume.markOperationStarted ||
      !volume.releaseOperation
    ) {
      throw new Error(
        "SANDBOX_VOLUME_SUPERVISOR_REQUIRED: protected workload control and database admission must be available before durable mutations are enabled.",
      );
    }
    input.signal?.throwIfAborted();
    const identity = await control.identity({
      providerSandboxId: input.sandbox.providerSandboxId,
    });
    if (
      identity.protocolVersion !== 1 ||
      identity.boundary !== "pid-namespace" ||
      identity.protectedControl !== true ||
      !identity.supervisorNonce ||
      !identity.bootId
    ) {
      throw new Error(
        "SANDBOX_VOLUME_SUPERVISOR_UNVERIFIED: protected workload identity was not confirmed.",
      );
    }
    this.assertLazyMount(
      identity,
      input.sandbox.providerSandboxId,
      attachmentId,
    );
    this.assertStableFreeze(identity);
    let permit: { permitId: string; reused: boolean };
    for (;;) {
      input.signal?.throwIfAborted();
      try {
        permit = await volume.acquireOperation({
          attachmentId,
          operationId: input.operationId,
          sandboxId: input.sandbox.providerSandboxId,
          bootId: identity.bootId,
          supervisorNonce: identity.supervisorNonce,
          writerKind: input.writerKind ?? "external",
        });
        break;
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "VOLUME_EXECUTION_QUEUED"
        )
          throw error;
        await waitForPermit(100, undefined, { signal: input.signal });
      }
    }
    if (this.volumeOperationIdentities.has(permit.permitId)) {
      throw new Error(
        "SANDBOX_VOLUME_OPERATION_IN_PROGRESS: this permit is already in flight in this manager; do not dispatch it again.",
      );
    }
    this.volumeOperationIdentities.set(permit.permitId, identity);
    let confirmedSequence: number | undefined;
    let started = false;
    let completedResult: T | undefined;
    try {
      input.signal?.throwIfAborted();
      await volume.assertActive({
        attachmentId,
        executor: this.volumeExecutor(input.sandbox),
      });
      input.signal?.throwIfAborted();
      if (
        identity.lazyMount ||
        this.lazyMountBindings.has(input.sandbox.providerSandboxId)
      ) {
        const fresh = await control.identity({
          providerSandboxId: input.sandbox.providerSandboxId,
        });
        if (
          fresh.supervisorNonce !== identity.supervisorNonce ||
          fresh.bootId !== identity.bootId
        )
          throw new Error(
            "SANDBOX_VOLUME_LAZY_MOUNT_UNVERIFIED: controller changed before dispatch; preserve the original workspace",
          );
        this.assertLazyMount(
          fresh,
          input.sandbox.providerSandboxId,
          attachmentId,
        );
      }
      // This durable transition precedes any provider request. A previous worker's
      // started operation is never dispatched again just because its result was lost.
      if (
        !(await volume.markOperationStarted({
          attachmentId,
          permitId: permit.permitId,
        }))
      ) {
        started = true;
        throw new Error(
          "SANDBOX_VOLUME_OPERATION_RECOVERY_REQUIRED: this operation was already dispatched; recover its supervisor result before continuing.",
        );
      }
      started = true;
      const result = await input.run(permit.permitId);
      completedResult = result;
      input.signal?.throwIfAborted();
      if (
        identity.lazyMount ||
        this.lazyMountBindings.has(input.sandbox.providerSandboxId)
      ) {
        const fresh = await control.identity({
          providerSandboxId: input.sandbox.providerSandboxId,
        });
        if (
          fresh.supervisorNonce !== identity.supervisorNonce ||
          fresh.bootId !== identity.bootId
        )
          throw new Error(
            "SANDBOX_VOLUME_LAZY_MOUNT_UNVERIFIED: controller changed after dispatch; result durability is unknown",
          );
        this.assertLazyMount(
          fresh,
          input.sandbox.providerSandboxId,
          attachmentId,
        );
      }
      const freezeId = `barrier-${permit.permitId}`;
      const proof = await control.freeze({
        providerSandboxId: input.sandbox.providerSandboxId,
        expectedNonce: identity.supervisorNonce,
        freezeId,
      });
      if (
        proof.freezeId !== freezeId ||
        proof.supervisorNonce !== identity.supervisorNonce ||
        proof.allWritersStopped !== true ||
        proof.kernelEnforced !== true ||
        proof.kernelIoQuiescent !== true ||
        proof.mechanism !== identity.stableFreeze.mechanism
      ) {
        throw new Error(
          "SANDBOX_VOLUME_FREEZE_UNCONFIRMED: workspace writers were not confirmed stopped; retain the operation for recovery.",
        );
      }
      const barrier = { freezeId, supervisorNonce: identity.supervisorNonce };
      this.verifiedFreezeBarriers.set(input.sandbox.providerSandboxId, barrier);
      const confirmedSeq = input.checkpoint
        ? await input.checkpoint(result, barrier)
        : await this.volumeCheckpoint(input.sandbox, barrier);
      if (!Number.isSafeInteger(confirmedSeq) || confirmedSeq < 0) {
        throw new Error(
          "SANDBOX_VOLUME_PERSISTENCE_UNCONFIRMED: the frozen workspace checkpoint has no confirmed sequence.",
        );
      }
      confirmedSequence = confirmedSeq;
      // Reopening writers invalidates this proof even if its acknowledgement is lost.
      this.verifiedFreezeBarriers.delete(input.sandbox.providerSandboxId);
      await control.resume({
        providerSandboxId: input.sandbox.providerSandboxId,
        expectedNonce: identity.supervisorNonce,
        freezeId,
      });
      await volume.releaseOperation({
        attachmentId,
        permitId: permit.permitId,
        outcome: "persisted",
        confirmedSeq,
      });
      this.volumeOperationIdentities.delete(permit.permitId);
      return result;
    } catch (error) {
      if (!started)
        await volume.releaseOperation({
          attachmentId,
          permitId: permit.permitId,
          outcome: "not_started",
        });
      if (confirmedSequence !== undefined) {
        const value =
          completedResult && typeof completedResult === "object"
            ? (completedResult as { output?: unknown; exitCode?: unknown })
            : {};
        throw new SandboxVolumeRecoveryPendingError({
          attachmentId,
          confirmedSeq: confirmedSequence,
          status:
            this.volumeConfirmedModes.get(input.sandbox.providerSandboxId) ===
            "shadow"
              ? "pending"
              : "confirmed",
          exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
          output: typeof value.output === "string" ? value.output : undefined,
          cause: error,
        });
      }
      // After dispatch, neither an exception nor a timeout proves the absence of
      // writes. Retain the permit and any freeze until the recovery worker resolves it.
      if (
        completedResult &&
        typeof completedResult === "object" &&
        "output" in completedResult &&
        "exitCode" in completedResult &&
        typeof completedResult.output === "string" &&
        (completedResult.exitCode === null ||
          typeof completedResult.exitCode === "number")
      ) {
        throw new SandboxVolumePersistenceError({
          attachmentId,
          output: completedResult.output,
          exitCode: completedResult.exitCode,
          status:
            error &&
            typeof error === "object" &&
            "durabilityStatus" in error &&
            error.durabilityStatus === "failed"
              ? "failed"
              : "unknown",
          cause: error,
        });
      }
      throw error;
    } finally {
      this.verifiedFreezeBarriers.delete(input.sandbox.providerSandboxId);
      // The database may intentionally retain an uncertain permit, but this
      // finished invocation must not leave a reusable local dispatch grant.
      this.volumeOperationIdentities.delete(permit.permitId);
    }
  }

  async executeUserCommand(
    sandbox: SandboxRef,
    input: Parameters<SandboxProvider["execute"]>[0],
    trusted = false,
  ): Promise<SandboxExecuteResult> {
    const provider = this.input.provider;
    if (
      this.input.volume &&
      this.volumeAttachments.has(sandbox.providerSandboxId)
    ) {
      const identity = input.executionId
        ? this.volumeOperationIdentities.get(input.executionId)
        : undefined;
      if (!provider.executeSupervised || !identity) {
        throw new Error(
          "SANDBOX_VOLUME_WORKLOAD_RPC_REQUIRED: durable commands require their admitted, protected workload execution RPC.",
        );
      }
      return provider.executeSupervised({
        ...input,
        expectedNonce: identity.supervisorNonce,
      });
    }
    return trusted && provider.executeSystem
      ? provider.executeSystem(input)
      : provider.execute(input);
  }

  /** The command to hand to the provider: wrapped with the volume's identity check and sync barrier when a volume is attached. */
  volumeWrapCommand(sandbox: SandboxRef, command: string): string {
    if (
      !this.input.volume ||
      !this.volumeAttachments.has(sandbox.providerSandboxId)
    )
      return command;
    return this.input.volume.wrapCommand(command);
  }

  /**
   * Parse the completed command's report. No error here authorizes replay:
   * the command may have run, and stdout is not trusted preflight evidence.
   */
  async volumeParseResult(
    sandbox: SandboxRef,
    result: SandboxExecuteResult,
  ): Promise<SandboxExecuteResult> {
    const volume = this.input.volume;
    const attachmentId = this.volumeAttachments.get(sandbox.providerSandboxId);
    if (!volume || !attachmentId) return result;
    try {
      const parsed = await volume.parseResult({
        attachmentId,
        output: result.output,
        exitCode: result.exitCode,
        executor: this.volumeExecutor(sandbox),
      });
      if (parsed?.sync?.persisted !== true) {
        throw Object.assign(
          new Error(
            "SANDBOX_VOLUME_PERSISTENCE_UNCONFIRMED: the command ran, but its changes were not confirmed durable. Do not execute the command again.",
          ),
          {
            code: "SANDBOX_VOLUME_PERSISTENCE_UNCONFIRMED",
            commandOutput: parsed?.output,
            commandExitCode: parsed?.exitCode,
          },
        );
      }
      return {
        ...result,
        output:
          parsed.sync.mode === "shadow"
            ? `${parsed.output}\nSandbox volume shadow observation completed; production persistence is not confirmed.`
            : parsed.output,
        exitCode: parsed.exitCode,
        durability: {
          status: parsed.sync.mode === "shadow" ? "pending" : "confirmed",
          attachmentId,
          ...(Number.isSafeInteger(parsed.sync.confirmedSeq) &&
          parsed.sync.confirmedSeq! >= 0
            ? { confirmedSeq: parsed.sync.confirmedSeq }
            : {}),
        },
      };
    } catch (error) {
      const detail =
        error !== null && typeof error === "object"
          ? (error as {
              commandOutput?: unknown;
              commandExitCode?: unknown;
              durabilityStatus?: unknown;
            })
          : {};
      throw new SandboxVolumePersistenceError({
        attachmentId,
        exitCode:
          typeof detail.commandExitCode === "number"
            ? detail.commandExitCode
            : result.exitCode,
        ...(typeof detail.commandOutput === "string"
          ? { output: detail.commandOutput }
          : {}),
        status: detail.durabilityStatus === "failed" ? "failed" : "unknown",
        cause: error,
      });
    }
  }

  async reattachVolume(
    sandbox: SandboxRef,
    context: SandboxRuntimeContext,
  ): Promise<void> {
    const volume = this.input.volume;
    if (!volume) return;
    const attached = await volume.onContainerReplaced({
      scope: this.volumeScope(context),
      sandboxId: sandbox.providerSandboxId,
      previousSandboxId: sandbox.providerSandboxId,
      executor: this.volumeExecutor(sandbox),
    });
    this.volumeAttachments.set(
      sandbox.providerSandboxId,
      attached.attachmentId,
    );
  }

  /** A pidfd-backed mount binding is independent of kernel-I/O quiescence.
   * No mountMode is inferred: protected bootstrap must report required mounts. */
  private assertLazyMount(
    identity: SandboxSupervisorIdentity,
    sandboxId: string,
    attachmentId?: string,
  ): void {
    const previous = this.lazyMountBindings.get(sandboxId);
    const status = identity.lazyMount;
    const reject = (): never => {
      throw new Error(
        "SANDBOX_VOLUME_LAZY_MOUNT_UNVERIFIED: original dispatcher, mount and fixed lower plan are not verified; preserve upper/pending and do not replay or remount",
      );
    };
    // A required declaration is sticky before attachment creation as well as
    // after it. Missing fields or a new controller need explicit verified
    // bootstrap/recovery, never an implicit downgrade to eager behavior.
    if (status?.required === true && !this.lazyMountIntents.has(sandboxId)) {
      this.lazyMountIntents.set(sandboxId, {
        bootId: identity.bootId,
        supervisorNonce: identity.supervisorNonce,
      });
    }
    const intent = this.lazyMountIntents.get(sandboxId);
    if (
      intent &&
      (intent.bootId !== identity.bootId ||
        intent.supervisorNonce !== identity.supervisorNonce)
    )
      return reject();
    if (status === undefined && previous === undefined && intent === undefined)
      return;
    if (
      !status ||
      status.required !== true ||
      status.state !== "registered" ||
      status.controllerNonce !== identity.supervisorNonce
    )
      return reject();
    const binding = status.registration;
    const token = (v: unknown) =>
      typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
    const path = (v: unknown) =>
      typeof v === "string" &&
      v.startsWith("/") &&
      v.length <= 4096 &&
      !v.includes("\0") &&
      !v.split("/").some((c) => c === ".." || c === ".");
    if (
      !binding ||
      !token(binding.volumeId) ||
      !token(binding.attachmentId) ||
      binding.bootId !== identity.bootId ||
      (attachmentId !== undefined && binding.attachmentId !== attachmentId) ||
      !Number.isSafeInteger(binding.fixedBaseSeq) ||
      binding.fixedBaseSeq < 0 ||
      !/^[a-f0-9]{64}$/.test(binding.planSha256) ||
      !path(binding.planPath) ||
      !path(binding.mountPath) ||
      !path(binding.dispatcherExecutable) ||
      !Number.isSafeInteger(binding.mountId) ||
      binding.mountId <= 0 ||
      binding.deviceMajor !== 0 ||
      !Number.isSafeInteger(binding.deviceMinor) ||
      binding.deviceMinor <= 0 ||
      binding.fsName !== "swvol" ||
      (binding.fsType !== "fuse" && binding.fsType !== "fuse.swvol") ||
      !Number.isSafeInteger(binding.dispatcherPid) ||
      binding.dispatcherPid <= 1 ||
      !/^[0-9]+$/.test(binding.dispatcherStartTime)
    )
      reject();
    const key = JSON.stringify([
      status.controllerNonce,
      binding.volumeId,
      binding.attachmentId,
      binding.bootId,
      binding.fixedBaseSeq,
      binding.planSha256,
      binding.planPath,
      binding.mountPath,
      binding.mountId,
      binding.deviceMajor,
      binding.deviceMinor,
      binding.fsName,
      binding.fsType,
      binding.dispatcherPid,
      binding.dispatcherStartTime,
      binding.dispatcherExecutable,
    ]);
    if (previous !== undefined && previous !== key) reject();
    this.lazyMountBindings.set(sandboxId, key);
  }

  /** Full-scan barrier before a sandbox goes away; a no-op without a volume. */
  private assertStableFreeze(identity: SandboxSupervisorIdentity): void {
    if (
      identity.stableFreeze?.available !== true ||
      identity.stableFreeze.mechanism !== "cgroup-v2-freezer" ||
      identity.stableFreeze.kernelEnforced !== true ||
      identity.stableFreeze.kernelIoQuiescence !== "qualified"
    ) {
      throw new Error(
        "SANDBOX_VOLUME_STABLE_FREEZE_UNAVAILABLE: a verified workspace barrier covering pending kernel I/O is required before attachment or durable execution; diagnostic signal/cgroup pauses do not qualify.",
      );
    }
  }

  async volumeCheckpoint(
    sandbox: SandboxRef,
    barrier: {
      freezeId?: string;
      drainId?: string;
      supervisorNonce?: string;
    } = {},
  ): Promise<number> {
    const volume = this.input.volume;
    const attachmentId = this.volumeAttachments.get(sandbox.providerSandboxId);
    if (!volume || !attachmentId) return 0;
    const control = this.input.provider.volumeControl;
    if (control) {
      this.assertLazyMount(
        await control.identity({
          providerSandboxId: sandbox.providerSandboxId,
        }),
        sandbox.providerSandboxId,
        attachmentId,
      );
    }
    if (
      !control ||
      !barrier.supervisorNonce ||
      (!barrier.freezeId && !barrier.drainId)
    ) {
      throw new SandboxVolumePersistenceError({
        attachmentId,
        exitCode: null,
        cause: new Error(
          "protected persistence checkpoint requires a supervisor freeze or drain fence",
        ),
      });
    }
    if (barrier.freezeId) {
      const verified = this.verifiedFreezeBarriers.get(
        sandbox.providerSandboxId,
      );
      if (
        !verified ||
        verified.freezeId !== barrier.freezeId ||
        verified.supervisorNonce !== barrier.supervisorNonce
      ) {
        throw new SandboxVolumePersistenceError({
          attachmentId,
          exitCode: null,
          cause: new Error(
            "STABLE_FREEZE_UNAVAILABLE: checkpoint has no validated kernel freeze proof for this operation",
          ),
        });
      }
    }
    const checkpoint = await volume.checkpoint({
      attachmentId,
      executor: this.volumeExecutor(sandbox),
      ...(barrier.freezeId ? { freezeId: barrier.freezeId } : {}),
      ...(barrier.drainId ? { drainId: barrier.drainId } : {}),
      supervisorNonce: barrier.supervisorNonce,
      ...(control && barrier.supervisorNonce
        ? {
            trustedFlush: async (input: {
              attachmentId: string;
              freezeId?: string;
              drainId?: string;
            }) =>
              control.flush({
                providerSandboxId: sandbox.providerSandboxId,
                expectedNonce: barrier.supervisorNonce!,
                attachmentId: input.attachmentId,
                freezeId: input.freezeId,
                drainId: input.drainId,
                full: true,
              }),
          }
        : {}),
    });
    if (
      checkpoint?.sync?.persisted !== true ||
      !Number.isSafeInteger(checkpoint.sync.confirmedSeq) ||
      checkpoint.sync.confirmedSeq! < 0
    ) {
      throw new SandboxVolumePersistenceError({
        attachmentId,
        exitCode: null,
        cause: new Error(
          "sandbox checkpoint has no confirmed persistence sequence",
        ),
      });
    }
    this.volumeConfirmedModes.set(
      sandbox.providerSandboxId,
      checkpoint.sync.mode ?? "full",
    );
    return checkpoint.sync.confirmedSeq!;
  }

  volumeConfirmedResult(
    sandbox: SandboxRef,
    result: SandboxExecuteResult,
    confirmedSeq?: number,
  ): SandboxExecuteResult {
    const attachmentId = this.volumeAttachments.get(sandbox.providerSandboxId);
    if (!this.input.volume || !attachmentId) return result;
    if (!Number.isSafeInteger(confirmedSeq) || confirmedSeq! < 0) {
      throw new SandboxVolumePersistenceError({
        attachmentId,
        exitCode: result.exitCode,
        output: result.output,
        cause: new Error("no frozen workspace checkpoint was confirmed"),
      });
    }
    const shadow =
      this.volumeConfirmedModes.get(sandbox.providerSandboxId) === "shadow";
    return {
      ...result,
      output: shadow
        ? `${result.output}\nSandbox volume shadow observation completed; production persistence is not confirmed.`
        : result.output,
      durability: {
        status: shadow ? "pending" : "confirmed",
        attachmentId,
        confirmedSeq,
      },
    };
  }

  // A failed acquisition is shared too: siblings must not each start a new
  // sandbox after the same failure. A new run has its own initialization.
  private readonly initializationRuns = new Map<string, Promise<SandboxRef>>();

  private async acquisitionPhase<T>(
    phase: string,
    context: SandboxRuntimeContext,
    operation: () => Promise<T>,
    sandboxId?: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.input.logWarn?.("sandbox.acquire.failed", {
        phase,
        provider: this.input.provider.id,
        ...context,
        sandboxId,
        error: sandboxErrorDiagnostic(error),
      });
      throw error;
    }
  }

  private checkReusableSandbox(providerSandboxId: string) {
    return this.input.provider.checkSandboxHealth
      ? this.input.provider.checkSandboxHealth(providerSandboxId)
      : this.input.provider.getSandbox(providerSandboxId);
  }

  /**
   * Per-provider-sandbox staging memo. The manager lives for one turn, so
   * this holds at most one entry in practice; the map keeps correctness if a
   * sandbox is replaced mid-turn (expiry → recreate gets a fresh staging run).
   *
   * The memo is per BUNDLE, not per sandbox: a plan registered after the
   * first staging run (a skill installed mid-turn) is staged by the next run,
   * while bundles already attempted here are never re-uploaded or retried.
   */
  private readonly skillStagingStates = new Map<string, SkillStagingState>();
  private readonly requiredAssetStagingRuns = new Map<
    string,
    Promise<RuntimeAssetResolution[]>
  >();
  /** One physical termination request per host-issued execution identity. */
  private readonly cancellationRuns = new Map<
    string,
    Promise<SandboxCancellationResult>
  >();
  /** In-flight termination decisions that sibling executions must observe. */
  private readonly sandboxCancellationRuns = new Map<
    string,
    Set<Promise<SandboxCancellationResult>>
  >();
  /** Terminal generation fence for a sandbox that must never be reused. */
  private readonly invalidatedSandboxes = new Map<
    string,
    Exclude<SandboxExecutionResultDisposition, "accepted">
  >();
  private latestRequiredAssetResolutions: RuntimeAssetResolution[] | null =
    null;
  private latestSkillResolutions: RuntimeAssetResolution[] | null = null;

  private sandboxExpiresAt() {
    return new Date(Date.now() + this.input.ttlSeconds * 1000);
  }

  private staleOperationBefore() {
    return new Date(
      Date.now() -
        this.input.maxCommandTimeoutMs -
        SANDBOX_OPERATION_STALE_GRACE_MS,
    );
  }

  async getOrCreateThreadSandbox(
    context: SandboxRuntimeContext,
    options: { waitTimeoutMs?: number; waitIntervalMs?: number } = {},
  ): Promise<SandboxRef> {
    const key = JSON.stringify([
      this.input.provider.id,
      context.teamId,
      context.workspaceId,
      context.threadId,
      context.runId,
      context.userId,
    ]);
    let initialization = this.initializationRuns.get(key);
    if (!initialization) {
      initialization = (async () => {
        const sandbox = await this.acquireThreadSandbox(context, options);
        await this.acquisitionPhase(
          "prepare",
          context,
          async () => {
            await this.ensureVolumeAttached(sandbox, context);
            await this.ensureRequiredAssetsOnce(sandbox);
            await this.ensureSkillAssetsStaged(sandbox);
          },
          sandbox.id,
        );
        return sandbox;
      })();
      this.initializationRuns.set(key, initialization);
    }
    const sandbox = await initialization;
    if (this.invalidatedSandboxes.has(sandbox.providerSandboxId)) {
      throw new SandboxInstanceChangedError();
    }
    await this.acquisitionPhase(
      "renew",
      context,
      async () => {
        const touched = await this.input.sandboxStore.touchSandbox({
          sandboxId: sandbox.id,
          providerSandboxId: sandbox.providerSandboxId,
          expiresAt: this.sandboxExpiresAt(),
        });
        if (!touched) throw new SandboxInstanceChangedError();
      },
      sandbox.id,
    );
    return sandbox;
  }

  private async acquireThreadSandbox(
    context: SandboxRuntimeContext,
    options: { waitTimeoutMs?: number; waitIntervalMs?: number } = {},
  ): Promise<SandboxRef> {
    const waitTimeoutMs =
      options.waitTimeoutMs ?? SANDBOX_CREATING_WAIT_TIMEOUT_MS;
    const waitIntervalMs =
      options.waitIntervalMs ?? SANDBOX_CREATING_WAIT_INTERVAL_MS;
    const waitStartedAt = Date.now();

    for (;;) {
      const existing = await this.acquisitionPhase("lookup", context, () =>
        this.input.sandboxStore.findLatestActiveThreadSandbox({
          provider: this.input.provider.id,
          context,
        }),
      );

      if (existing) {
        if (existing.status === "creating") {
          const ageMs = Date.now() - existing.updatedAt.getTime();
          if (ageMs < SANDBOX_CREATING_STALE_MS) {
            if (Date.now() - waitStartedAt < waitTimeoutMs) {
              await sleep(waitIntervalMs);
              continue;
            }
            throw new Error(
              "SANDBOX_CREATION_WAIT_TIMEOUT: sandbox creation is still running for this thread.",
            );
          }
          const claimed =
            await this.input.sandboxStore.markCreatingSandboxError({
              sandboxId: existing.id,
              expectedUpdatedAt: existing.updatedAtToken ?? existing.updatedAt,
            });
          if (!claimed) {
            throw new Error(
              "SANDBOX_CREATION_IN_PROGRESS: stale sandbox creation was already claimed by another worker.",
            );
          }
        } else {
          try {
            await this.acquisitionPhase(
              "check",
              context,
              () => this.checkReusableSandbox(existing.providerSandboxId),
              existing.id,
            );
          } catch (error) {
            if (!isSandboxInstanceMissingError(error)) throw error;
            if (
              this.input.volume &&
              !hasSandboxPhysicalAbsenceEvidence(error, {
                provider: this.input.provider.id,
                providerSandboxId: existing.providerSandboxId,
              })
            ) {
              const control = this.input.provider.volumeControl;
              if (control) {
                const identity = await control.identity({
                  providerSandboxId: existing.providerSandboxId,
                });
                if (
                  identity.protocolVersion === 1 &&
                  identity.protectedControl === true &&
                  identity.boundary === "pid-namespace"
                ) {
                  // A missing user-writable stamp is not a missing instance. Keep
                  // the same disk and let attachment recovery verify its identity.
                  return {
                    id: existing.id,
                    provider: this.input.provider.id,
                    providerSandboxId: existing.providerSandboxId,
                  };
                }
              }
              throw new Error(
                "SANDBOX_VOLUME_INSTANCE_UNVERIFIED: a missing or altered stamp does not prove instance loss; preserve the existing writable volume for protected identity recovery.",
              );
            }
            const expired = await this.input.sandboxStore.markSandboxExpired({
              sandboxId: existing.id,
              providerSandboxId: existing.providerSandboxId,
              expectedStatus: "ready",
              expectedUpdatedAt: existing.updatedAtToken ?? existing.updatedAt,
            });
            if (expired) {
              this.missingVolumeInstances.set(
                this.volumeScopeKey(context),
                existing.providerSandboxId,
              );
            }
            // A concurrent renewal/transition won. Re-read rather than
            // creating from a stale observation of the previous generation.
            if (!expired && Date.now() - waitStartedAt >= waitTimeoutMs) {
              throw new SandboxInstanceChangedError();
            }
            continue;
          }
          return {
            id: existing.id,
            provider: this.input.provider.id,
            providerSandboxId: existing.providerSandboxId,
          };
        }
      }

      const id = randomUUID();
      const pendingProviderSandboxId = `creating:${id}`;
      const inserted = await this.input.sandboxStore.insertCreatingSandbox({
        sandboxId: id,
        provider: this.input.provider.id,
        providerSandboxId: pendingProviderSandboxId,
        context,
        expiresAt: this.sandboxExpiresAt(),
      });

      if (!inserted) {
        if (Date.now() - waitStartedAt >= waitTimeoutMs) {
          throw new Error(
            "SANDBOX_CREATION_WAIT_TIMEOUT: sandbox acquisition is still in progress.",
          );
        }
        await sleep(waitIntervalMs);
        continue;
      }

      const startedAt = Date.now();
      let providerSandboxId: string | undefined;
      try {
        const sandbox = await this.createProviderSandbox(context, id);
        providerSandboxId = sandbox.id;
        await this.checkReusableSandbox(sandbox.id);
        const ready = await this.input.sandboxStore.markSandboxReady({
          sandboxId: id,
          providerSandboxId: sandbox.id,
          expiresAt: this.sandboxExpiresAt(),
        });
        if (!ready) throw new SandboxInstanceChangedError();
        await this.recordOperation({
          context,
          sandboxId: id,
          operationType: "create",
          status: "succeeded",
          result: { providerSandboxId: sandbox.id },
          durationMs: Date.now() - startedAt,
        });
        return {
          id,
          provider: this.input.provider.id,
          providerSandboxId: sandbox.id,
        };
      } catch (error) {
        this.input.logWarn?.("sandbox.acquire.failed", {
          phase: "create",
          provider: this.input.provider.id,
          ...context,
          sandboxId: id,
          providerSandboxId,
          error: sandboxErrorDiagnostic(error),
        });
        try {
          await this.input.sandboxStore.markCreatingSandboxError({
            sandboxId: id,
          });
          await this.recordOperation({
            context,
            sandboxId: id,
            operationType: "create",
            status: "failed",
            result: {
              error: error instanceof Error ? error.message : String(error),
              diagnostic: sandboxErrorDiagnostic(error),
            },
            durationMs: Date.now() - startedAt,
          });
        } catch (recordingError) {
          this.input.logWarn?.("sandbox.acquire.failed", {
            phase: "record_create_failure",
            provider: this.input.provider.id,
            ...context,
            sandboxId: id,
            providerSandboxId,
            error: sandboxErrorDiagnostic(recordingError),
          });
        }
        throw error;
      }
    }
  }

  /**
   * Create the provider sandbox, riding out a momentary provider outage.
   *
   * One connection reset on the way to the provider used to fail the whole
   * acquisition, and with it the model's command — a network blip surfaced to
   * the user as "command failed". Creation has no side effect we depend on
   * yet, so it is retried; NOTHING else here is: a command that timed out or
   * lost its connection may already have run.
   *
   * Only the adapter's typed `unavailable` code retries — never the message
   * text, and never auth/unknown errors, which a retry cannot fix. The cost of
   * being wrong about "it did not happen": if the first create actually
   * succeeded and only its response was lost, the retry leaves one unused
   * sandbox behind; it carries our labels and the provider reaps it at its TTL.
   */
  private async createProviderSandbox(
    context: SandboxRuntimeContext,
    sandboxId: string,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.input.provider.createSandbox({
          ttlSeconds: this.input.ttlSeconds,
          labels: {
            sourceweft: "true",
            provider: this.input.provider.id,
            team_id: context.teamId,
            workspace_id: context.workspaceId,
            thread_id: context.threadId,
            user_id: context.userId,
            environment: this.input.environment ?? "development",
          },
        });
      } catch (error) {
        const delayMs = SANDBOX_CREATE_RETRY_DELAYS_MS[attempt];
        if (
          delayMs === undefined ||
          !isSandboxProviderUnavailableError(error)
        ) {
          throw error;
        }
        this.input.logWarn?.("sandbox.create.retry", {
          provider: this.input.provider.id,
          ...context,
          sandboxId,
          attempt: attempt + 1,
          maxRetries: SANDBOX_CREATE_RETRY_DELAYS_MS.length,
          delayMs,
          error: sandboxErrorDiagnostic(error),
        });
        // Jitter so callers that failed together do not retry together.
        await sleep(delayMs + Math.floor(Math.random() * (delayMs / 4)));
      }
    }
  }

  /**
   * True when this runtime has skill-bundle plans to stage RIGHT NOW. Live on
   * purpose: the plan set can grow mid-turn, and the execute path's /skills
   * deny-or-defer decision must follow it rather than the turn-start snapshot.
   */
  skillStagingConfigured() {
    const staging = this.input.skillStaging;
    if (!staging) {
      return false;
    }
    return staging.hasPlans ? staging.hasPlans() : true;
  }

  /**
   * True when at least one skill bundle resolved into /skills for the current
   * sandbox — the signal the execute path's two-phase /skills check consumes.
   * False both before any sandbox exists and after a fully failed staging, so
   * a caller that never acquired a sandbox conservatively keeps /skills
   * denied.
   */
  skillScriptsStaged() {
    return Boolean(
      this.latestSkillResolutions?.some((resolution) => resolution.ok),
    );
  }

  /**
   * The per-command form of `skillScriptsStaged`: a command naming
   * `/skills/<name>` whose bundle failed to stage is unavailable even when
   * other bundles resolved — a failed bundle degrades alone, and the model
   * gets the recoverable staging error instead of a bare "No such file".
   * Names the registry never planned are left to the shell, as before.
   */
  skillScriptsStagedForCommand(command: string) {
    if (!this.skillScriptsStaged()) {
      return false;
    }
    const failed = new Set(
      (this.latestSkillResolutions ?? [])
        .filter((resolution) => !resolution.ok)
        .map((resolution) => resolution.name),
    );
    if (failed.size === 0) {
      return true;
    }
    for (const match of command.matchAll(SKILL_NAME_IN_COMMAND)) {
      if (match[1] && failed.has(match[1])) {
        return false;
      }
    }
    return true;
  }

  /** Per-bundle staging outcomes for observability; null before staging ran. */
  skillAssetResolutions() {
    return this.latestSkillResolutions;
  }

  requiredAssetResolutions() {
    return this.latestRequiredAssetResolutions;
  }

  /** Required assets fail the sandbox acquisition instead of degrading. */
  private async ensureRequiredAssetsOnce(sandbox: SandboxRef) {
    const staging = this.input.requiredAssetStaging;
    if (!staging) {
      return;
    }
    let run = this.requiredAssetStagingRuns.get(sandbox.providerSandboxId);
    if (!run) {
      run = this.runRequiredAssetStaging(sandbox, staging);
      this.requiredAssetStagingRuns.set(sandbox.providerSandboxId, run);
    }
    this.latestRequiredAssetResolutions = await run;
  }

  private async runRequiredAssetStaging(
    sandbox: SandboxRef,
    staging: SandboxRuntimeAssetStaging,
  ): Promise<RuntimeAssetResolution[]> {
    const plans = await staging.plans();
    const resolutions = await ensureRuntimeAssets({
      session: this.runtimeAssetStagingSession(
        sandbox.providerSandboxId,
        staging,
      ),
      assets: plans,
      ...(staging.logger ? { logger: staging.logger } : {}),
    });
    const failed = resolutions.filter((resolution) => !resolution.ok);
    if (failed.length > 0) {
      for (const resolution of failed) {
        staging.logger?.warn?.("sandbox_required_runtime_asset_failed", {
          asset: resolution.name,
          version: resolution.version,
          error: resolution.error,
        });
      }
      throw new Error(
        `SANDBOX_REQUIRED_RUNTIME_ASSET_UNAVAILABLE: ${failed
          .map((resolution) => `${resolution.name}@${resolution.version}`)
          .join(", ")}`,
      );
    }
    for (const resolution of resolutions) {
      staging.logger?.info?.("sandbox_required_runtime_asset_ready", {
        asset: resolution.name,
        version: resolution.version,
        rung: resolution.rung,
        ms: resolution.ms,
        ...(resolution.bytes !== undefined ? { bytes: resolution.bytes } : {}),
      });
    }
    return resolutions;
  }

  /**
   * Stage skill bundles into the sandbox: each bundle once per provider
   * sandbox per manager lifetime. Runs at sandbox acquisition, and again from
   * the execute path whenever a command references /skills, so a bundle
   * registered after acquisition is staged on its first use. A call with
   * nothing new costs one `plans()` read and no sandbox traffic. Never throws:
   * staging failure leaves the sandbox usable with /skills denied (today's
   * behavior), which the resolutions record.
   */
  async ensureSkillAssetsStaged(sandbox: SandboxRef) {
    const staging = this.input.skillStaging;
    if (!staging) {
      return;
    }
    let state = this.skillStagingStates.get(sandbox.providerSandboxId);
    if (!state) {
      state = { attempts: new Map(), tail: Promise.resolve() };
      this.skillStagingStates.set(sandbox.providerSandboxId, state);
    }
    const current = state;
    // Serialized per sandbox: parallel executes share one staging directory
    // per bundle, so two concurrent runs of the same plan would race on it.
    const run = current.tail.then(() =>
      this.stagePendingSkillPlans(sandbox, staging, current),
    );
    current.tail = run;
    await run;
    // Read after staging: building a plan can itself move a skill here. The
    // host's verdict wins over an earlier attempt under the same name.
    const unstageable = staging.unstageable?.() ?? [];
    const unstageableNames = new Set(unstageable.map((skill) => skill.name));
    this.latestSkillResolutions = [
      ...[...current.attempts.values()]
        .map((attempt) => attempt.resolution)
        .filter((resolution) => !unstageableNames.has(resolution.name)),
      ...unstageable.map((skill) => ({ ...skill, ok: false, ms: 0 })),
    ];
  }

  private async stagePendingSkillPlans(
    sandbox: SandboxRef,
    staging: SandboxSkillStaging,
    state: SkillStagingState,
  ): Promise<void> {
    try {
      const plans = await staging.plans();
      // A failed bundle is not retried within the turn (each attempt costs
      // several sandbox round trips); an identical bundle staged by an earlier
      // turn is caught by the engine's in-sandbox stamp, not by this memo.
      const pending = plans.filter(
        (plan) => state.attempts.get(plan.name)?.planKey !== skillPlanKey(plan),
      );
      if (pending.length === 0) {
        return;
      }
      const resolutions = await ensureRuntimeAssets({
        session: this.runtimeAssetStagingSession(
          sandbox.providerSandboxId,
          staging,
        ),
        assets: pending,
        ...(staging.logger ? { logger: staging.logger } : {}),
      });
      resolutions.forEach((resolution, index) => {
        const plan = pending[index];
        if (plan) {
          state.attempts.set(plan.name, {
            planKey: skillPlanKey(plan),
            resolution,
          });
        }
        if (!resolution.ok) {
          staging.logger?.warn?.("sandbox_skill_staging_failed", {
            skill: resolution.name,
            version: resolution.version,
            error: resolution.error,
          });
        } else {
          // Rung reporting per the runtime-assets no-silent-rungs rule (A4):
          // rollout verification reads these to see stamp-hit ratios and
          // staging latency without a metrics pipeline.
          staging.logger?.info?.("sandbox_skill_staged", {
            skill: resolution.name,
            version: resolution.version,
            rung: resolution.rung,
            ms: resolution.ms,
            ...(resolution.bytes !== undefined
              ? { bytes: resolution.bytes }
              : {}),
          });
        }
      });
    } catch (error) {
      staging.logger?.warn?.("sandbox_skill_staging_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Adapts the provider's per-file transfer surface to the runtime-asset
   * engine's session shape. Commands run through executeSystem when the
   * provider distinguishes it — staging is host-issued work, not model
   * command text.
   */
  private runtimeAssetStagingSession(
    providerSandboxId: string,
    staging: SandboxRuntimeAssetStaging,
  ): RuntimeAssetSessionLike {
    const provider = this.input.provider;
    const execute = provider.executeSystem
      ? provider.executeSystem.bind(provider)
      : provider.execute.bind(provider);
    return {
      rootDir: provider.pathPolicy.workspaceRoot,
      skillsRoot: provider.pathPolicy.skillsRoot,
      checksumCommand: provider.id === "local" ? "shasum -a 256" : undefined,
      execute: async (command) => {
        const result = await execute({
          providerSandboxId,
          command,
          timeoutMs: staging.commandTimeoutMs,
          maxOutputChars: staging.maxOutputChars,
        });
        return {
          exitCode: result.exitCode,
          output: result.output,
          ...(result.truncated !== undefined
            ? { truncated: result.truncated }
            : {}),
        };
      },
      uploadFiles: async (files) => {
        const results: Array<{ path: string; error?: string | null }> = [];
        for (const [path, content] of files) {
          try {
            await provider.uploadFile({
              providerSandboxId,
              sandboxPath: path,
              content,
            });
            results.push({ path });
          } catch (error) {
            results.push({
              path,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return results;
      },
      downloadFiles: async (paths) => {
        const results: Array<{
          path: string;
          content: Uint8Array | null;
          error?: string | null;
        }> = [];
        for (const path of paths) {
          try {
            const content = await provider.downloadFile({
              providerSandboxId,
              sandboxPath: path,
            });
            results.push({ path, content });
          } catch (error) {
            results.push({
              path,
              content: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return results;
      },
    };
  }

  async beginToolOperation(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
    request?: Record<string, unknown>;
  }): Promise<BeginToolOperationResult> {
    const request = input.request ?? {};
    const redactedRequest = redactSandboxOperationRequest(request);
    const staleBefore = this.staleOperationBefore();
    const claimNewOperation = async () => {
      const id = randomUUID();
      const inserted =
        await this.input.operationStore.insertRunningToolOperation({
          operationId: id,
          operationType: input.operationType,
          toolCallId: input.toolCallId,
          context: input.context,
          request: redactedRequest,
        });
      return inserted ? id : null;
    };
    const existing = await this.input.operationStore.findLatestToolOperation({
      context: input.context,
      operationType: input.operationType,
      toolCallId: input.toolCallId,
      statuses: ["running", "succeeded", "failed"],
    });
    const replay = resolveSandboxToolOperationReplay({
      operationType: input.operationType,
      existing,
      request,
      currentMessageId: input.context.messageId,
      staleBefore,
    });
    if (
      existing?.status === "running" &&
      existing.createdAt &&
      existing.createdAt <= staleBefore &&
      replay.kind === "proceed"
    ) {
      await this.input.operationStore.markStaleRunningToolOperationFailed({
        context: input.context,
        operationType: input.operationType,
        toolCallId: input.toolCallId,
        staleBefore,
        result: {
          errorCode: SANDBOX_OPERATION_STALE_RELEASED_CODE,
          error: `Sandbox ${input.operationType} operation was marked failed after exceeding the stale operation threshold.`,
        },
      });
    }
    if (replay.kind === "replay") {
      return { kind: "replay", result: replay.result };
    }
    if (replay.kind === "error") {
      throw new Error(replay.message);
    }

    const id = await claimNewOperation();
    if (id) {
      return { kind: "claimed", operationId: id };
    }

    const concurrent =
      await this.input.operationStore.findLatestActiveToolOperation({
        context: input.context,
        operationType: input.operationType,
        toolCallId: input.toolCallId,
      });

    if (
      concurrent &&
      !sameSandboxRequest(concurrent.requestJsonRedacted, request)
    ) {
      if (
        concurrent.status === "running" &&
        concurrent.createdAt &&
        concurrent.createdAt <= staleBefore
      ) {
        const released =
          await this.input.operationStore.markStaleRunningToolOperationFailed({
            context: input.context,
            operationType: input.operationType,
            toolCallId: input.toolCallId,
            staleBefore,
            result: {
              errorCode: SANDBOX_OPERATION_STALE_RELEASED_CODE,
              error: `Sandbox ${input.operationType} operation was marked failed after exceeding the stale operation threshold.`,
            },
          });
        if (released) {
          const retryId = await claimNewOperation();
          if (retryId) {
            return { kind: "claimed", operationId: retryId };
          }
        }
      }
      throw new Error(
        `SANDBOX_OPERATION_REQUEST_MISMATCH: sandbox ${input.operationType} request does not match the existing operation for this tool call.`,
      );
    }

    if (concurrent?.status === "succeeded") {
      return { kind: "replay", result: concurrent.resultJsonRedacted };
    }

    if (
      concurrent?.status === "running" &&
      concurrent.createdAt &&
      concurrent.createdAt <= staleBefore
    ) {
      const released =
        await this.input.operationStore.markStaleRunningToolOperationFailed({
          context: input.context,
          operationType: input.operationType,
          toolCallId: input.toolCallId,
          staleBefore,
          result: {
            errorCode: SANDBOX_OPERATION_STALE_RELEASED_CODE,
            error: `Sandbox ${input.operationType} operation was marked failed after exceeding the stale operation threshold.`,
          },
        });
      if (released) {
        const retryId = await claimNewOperation();
        if (retryId) {
          return { kind: "claimed", operationId: retryId };
        }
      }
    }

    throw new Error(
      `SANDBOX_OPERATION_IN_PROGRESS: sandbox ${input.operationType} is already running for this tool call.`,
    );
  }

  async releaseThreadSandboxLease(input: {
    context: SandboxRuntimeContext;
    graceMs?: number;
    reason: string;
  }) {
    return this.input.sandboxStore.releaseReadyThreadSandboxLease({
      context: input.context,
      provider: this.input.provider.id,
      expiresAt: new Date(
        Date.now() + (input.graceMs ?? SANDBOX_RELEASE_LEASE_GRACE_MS),
      ),
      reason: input.reason,
    });
  }

  async completeToolOperation(input: {
    operationId: string;
    sandboxId?: string | null;
    status: "succeeded" | "failed";
    result?: Record<string, unknown>;
    durationMs?: number;
  }) {
    if (input.sandboxId && input.status === "succeeded") {
      const touched = await this.input.sandboxStore.touchSandbox({
        sandboxId: input.sandboxId,
        expiresAt: this.sandboxExpiresAt(),
      });
      if (!touched) throw new SandboxInstanceChangedError();
    }
    await this.input.operationStore.completeToolOperation({
      ...input,
      result: input.result
        ? (redactSandboxSecrets(input.result) as Record<string, unknown>)
        : undefined,
    });
  }

  async expireThreadSandbox(input: { sandboxId: string }) {
    await this.input.sandboxStore.markSandboxExpired({
      sandboxId: input.sandboxId,
    });
  }

  /**
   * Physically terminate one provider execution. A provider may confirm a
   * command-scoped kill; otherwise the manager deletes the whole sandbox.
   * The promise is memoized so repeated Stop/deadline signals cannot issue a
   * second destructive provider request.
   */
  async cancelExecution(input: {
    sandbox: SandboxRef;
    executionId: string;
    reason: SandboxCancellationReason;
    /** File I/O has no provider command handle; deletion is the only proof. */
    forceSandbox?: boolean;
  }): Promise<SandboxCancellationResult> {
    const key = `${input.sandbox.providerSandboxId}\0${input.executionId}\0${input.forceSandbox === true ? "sandbox" : "provider"}`;
    let run = this.cancellationRuns.get(key);
    if (!run) {
      run = this.cancelExecutionOnce(input);
      this.cancellationRuns.set(key, run);
      let sandboxRuns = this.sandboxCancellationRuns.get(
        input.sandbox.providerSandboxId,
      );
      if (!sandboxRuns) {
        sandboxRuns = new Set();
        this.sandboxCancellationRuns.set(
          input.sandbox.providerSandboxId,
          sandboxRuns,
        );
      }
      sandboxRuns.add(run);
      void run
        .finally(() => {
          sandboxRuns!.delete(run!);
          if (sandboxRuns!.size === 0) {
            this.sandboxCancellationRuns.delete(
              input.sandbox.providerSandboxId,
            );
          }
        })
        .catch(() => undefined);
    }
    return run;
  }

  /**
   * Linearization fence for a provider result. If sandbox-scoped termination
   * started first, a sibling command may not turn its late bytes into success.
   * Command-scoped cancellation leaves unrelated siblings reusable.
   */
  async resolveExecutionResultDisposition(
    sandbox: SandboxRef,
    context: SandboxRuntimeContext,
  ): Promise<SandboxExecutionResultDisposition> {
    for (;;) {
      const invalidated = this.invalidatedSandboxes.get(
        sandbox.providerSandboxId,
      );
      if (invalidated) return invalidated;

      const active =
        await this.input.sandboxStore.findLatestActiveThreadSandbox({
          provider: sandbox.provider,
          context,
        });
      if (
        !active ||
        active.status !== "ready" ||
        active.id !== sandbox.id ||
        active.providerSandboxId !== sandbox.providerSandboxId
      ) {
        // The store proves only that this generation is no longer current.
        // That is not evidence that a user requested physical cancellation.
        return "instance_changed";
      }

      const currentRuns = this.sandboxCancellationRuns.get(
        sandbox.providerSandboxId,
      );
      if (!currentRuns || currentRuns.size === 0) return "accepted";
      const observedRuns = [...currentRuns];
      const outcomes = await Promise.all(
        observedRuns.map((run) =>
          run.catch((): SandboxCancellationResult => ({
            confirmed: false,
            mode: "unknown",
          })),
        ),
      );
      if (outcomes.some((outcome) => !outcome.confirmed)) {
        return "termination_unknown";
      }
      if (outcomes.some((outcome) => outcome.mode === "sandbox")) {
        return "sandbox_terminated";
      }

      const latestRuns = this.sandboxCancellationRuns.get(
        sandbox.providerSandboxId,
      );
      if (
        !latestRuns ||
        [...latestRuns].every((run) => observedRuns.includes(run))
      ) {
        const latestActive =
          await this.input.sandboxStore.findLatestActiveThreadSandbox({
            provider: sandbox.provider,
            context,
          });
        return latestActive?.status === "ready" &&
          latestActive.id === sandbox.id &&
          latestActive.providerSandboxId === sandbox.providerSandboxId
          ? "accepted"
          : "instance_changed";
      }
    }
  }

  private async cancelExecutionOnce(input: {
    sandbox: SandboxRef;
    executionId: string;
    reason: SandboxCancellationReason;
    forceSandbox?: boolean;
  }): Promise<SandboxCancellationResult> {
    const sandboxScoped =
      input.forceSandbox === true ||
      !this.input.provider.cancelExecution ||
      this.input.provider.cancellationScope !== "command";
    if (sandboxScoped && this.input.volume) {
      // A live writer cannot be safely checkpointed and deleted. Keep its disk,
      // fence this generation in the volume database, and expose unknown termination.
      this.invalidatedSandboxes.set(
        input.sandbox.providerSandboxId,
        "termination_unknown",
      );
      const attachmentId = this.volumeAttachments.get(
        input.sandbox.providerSandboxId,
      );
      try {
        if (!attachmentId)
          throw new Error("volume attachment is unavailable for quarantine");
        await this.input.volume.quarantine({
          attachmentId,
          reason: input.reason,
        });
      } catch (error) {
        this.input.logWarn?.("sandbox.volume.quarantine_failed", {
          sandboxId: input.sandbox.id,
          attachmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.input.logWarn?.(
        "sandbox.volume.cancellation_requires_command_scope",
        {
          sandboxId: input.sandbox.id,
          provider: this.input.provider.id,
          attachmentId,
        },
      );
      return { confirmed: false, mode: "unknown" };
    }
    let persistentFenceConfirmed = true;
    if (sandboxScoped) {
      // Persist the generation fence before asking the provider to terminate.
      // That ordering lets managers in other turns/processes reject late bytes
      // while physical deletion is still in flight.
      this.invalidatedSandboxes.set(
        input.sandbox.providerSandboxId,
        "termination_unknown",
      );
      try {
        await this.input.sandboxStore.markSandboxExpired({
          sandboxId: input.sandbox.id,
        });
      } catch {
        persistentFenceConfirmed = false;
      }
    }

    let result: SandboxCancellationResult;
    try {
      result = input.forceSandbox
        ? await this.deleteSandboxForCancellation(input.sandbox)
        : this.input.provider.cancelExecution
          ? await this.input.provider.cancelExecution({
              providerSandboxId: input.sandbox.providerSandboxId,
              executionId: input.executionId,
              reason: input.reason,
            })
          : await this.deleteSandboxForCancellation(input.sandbox);
    } catch {
      result = { confirmed: false, mode: "unknown" };
    }

    if (!persistentFenceConfirmed) {
      result = { confirmed: false, mode: "unknown" };
    }

    if (!result.confirmed || result.mode === "sandbox") {
      this.invalidatedSandboxes.set(
        input.sandbox.providerSandboxId,
        result.confirmed ? "sandbox_terminated" : "termination_unknown",
      );
      // A command-scoped provider can still report unknown or escalate to a
      // sandbox kill. Persist that unexpected generation quarantine now; the
      // ordinary sandbox-scoped path was fenced before provider cancellation.
      if (!sandboxScoped) {
        try {
          await this.input.sandboxStore.markSandboxExpired({
            sandboxId: input.sandbox.id,
          });
        } catch {
          result = { confirmed: false, mode: "unknown" };
          this.invalidatedSandboxes.set(
            input.sandbox.providerSandboxId,
            "termination_unknown",
          );
        }
      }
    }
    return result;
  }

  private async deleteSandboxForCancellation(
    sandbox: SandboxRef,
  ): Promise<SandboxCancellationResult> {
    await this.input.provider.deleteSandbox(sandbox.providerSandboxId);
    return { confirmed: true, mode: "sandbox" };
  }

  async recordOperation(input: {
    context: SandboxRuntimeContext;
    sandboxId?: string | null;
    operationType: SandboxOperationType;
    status: SandboxOperationStatus;
    toolCallId?: string | null;
    request?: Record<string, unknown>;
    result?: Record<string, unknown>;
    durationMs?: number;
  }) {
    const request = input.request
      ? redactSandboxOperationRequest(input.request)
      : undefined;
    const result = input.result
      ? (redactSandboxSecrets(input.result) as Record<string, unknown>)
      : undefined;
    await this.input.operationStore.recordOperation({
      operationId: randomUUID(),
      ...input,
      request,
      result,
    });
  }

  async findSucceededOperationByToolCall(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
  }): Promise<{ result: Record<string, unknown> } | null> {
    return this.input.operationStore.findSucceededOperationByToolCall(input);
  }

  providerForSandbox() {
    return this.input.provider;
  }
}
