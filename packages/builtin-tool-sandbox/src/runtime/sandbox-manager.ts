import { randomUUID } from "node:crypto";
import type {
  ExistingSandboxOperation,
  SandboxBridgeOperationType,
  SandboxOperationStatus,
  SandboxOperationStore,
  SandboxOperationType,
  SandboxProvider,
  SandboxRef,
  SandboxRuntimeContext,
  SandboxStore,
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
export type SandboxSkillStaging = {
  plans: () => Promise<RuntimeAssetPlan[]>;
  commandTimeoutMs: number;
  maxOutputChars: number;
  logger?: {
    info?(message: string, meta?: Record<string, unknown>): void;
    warn?(message: string, meta?: Record<string, unknown>): void;
  };
};

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

export function stableSandboxRequestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSandboxRequestJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSandboxRequestJson(item)}`)
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
  const error = typeof input.result.error === "string" ? ` Last failure: ${input.result.error}` : "";
  const operationId = input.existing.id ?? "unknown";
  const oldMessageId = input.existing.messageId ?? "unknown";
  const currentMessageId = input.currentMessageId ?? "unknown";
  const oldCreatedAt = input.existing.createdAt?.toISOString() ?? "unknown";
  const requestFingerprint = sandboxRequestFingerprint(input.request);
  return `SANDBOX_OPERATION_FAILED_RETRY_REQUIRED: sandbox ${input.operationType} previously failed for this tool call. Use a new toolCallId or include an explicit retry nonce/request hash to retry. Previous operation: id=${operationId}, messageId=${oldMessageId}, createdAt=${oldCreatedAt}. Current messageId=${currentMessageId}. Request fingerprint=${requestFingerprint}.${error}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveSandboxToolOperationReplay(input: {
  operationType: SandboxBridgeOperationType;
  existing: ExistingSandboxOperation | null;
  request: Record<string, unknown>;
  currentMessageId?: string;
  staleBefore?: Date;
}): { kind: "proceed" } | { kind: "replay"; result: Record<string, unknown> } | { kind: "error"; message: string } {
  const existing = input.existing;
  if (!existing) {
    return { kind: "proceed" };
  }
  const sameRequest = sameSandboxRequest(existing.requestJsonRedacted, input.request);
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
      skillStaging?: SandboxSkillStaging;
    },
  ) {}

  /**
   * Per-provider-sandbox staging memo. The manager lives for one turn, so
   * this holds at most one entry in practice; the map keeps correctness if a
   * sandbox is replaced mid-turn (expiry → recreate gets a fresh staging run).
   */
  private readonly skillStagingRuns = new Map<
    string,
    Promise<RuntimeAssetResolution[]>
  >();
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
    const sandbox = await this.acquireThreadSandbox(context, options);
    await this.ensureSkillAssetsOnce(sandbox);
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
      const existing = await this.input.sandboxStore.findLatestActiveThreadSandbox({
        provider: this.input.provider.id,
        context,
      });

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
          const claimed = await this.input.sandboxStore.markCreatingSandboxError({
            sandboxId: existing.id,
            expectedUpdatedAt: existing.updatedAt,
          });
          if (!claimed) {
            throw new Error(
              "SANDBOX_CREATION_IN_PROGRESS: stale sandbox creation was already claimed by another worker.",
            );
          }
        } else {
          try {
            await this.input.provider.getSandbox(existing.providerSandboxId);
            await this.input.provider.checkSandboxHealth?.(
              existing.providerSandboxId,
            );
            await this.input.sandboxStore.touchSandbox({
              sandboxId: existing.id,
              expiresAt: this.sandboxExpiresAt(),
            });
            return {
              id: existing.id,
              provider: this.input.provider.id,
              providerSandboxId: existing.providerSandboxId,
            };
          } catch {
            await this.input.sandboxStore.markSandboxExpired({
              sandboxId: existing.id,
            });
          }
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
        return this.acquireThreadSandbox(context, options);
      }

      const startedAt = Date.now();
      try {
        const sandbox = await this.input.provider.createSandbox({
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
        await this.input.provider.checkSandboxHealth?.(sandbox.id);
        await this.input.sandboxStore.markSandboxReady({
          sandboxId: id,
          providerSandboxId: sandbox.id,
          expiresAt: this.sandboxExpiresAt(),
        });
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
          },
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    }
  }

  /** True when this runtime was constructed with skill-bundle plans to stage. */
  skillStagingConfigured() {
    return Boolean(this.input.skillStaging);
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

  /** Per-bundle staging outcomes for observability; null before staging ran. */
  skillAssetResolutions() {
    return this.latestSkillResolutions;
  }

  /**
   * Stage skill bundles into the sandbox, once per provider sandbox per
   * manager lifetime. Never throws: staging failure leaves the sandbox usable
   * with /skills denied (today's behavior), which the resolutions record.
   */
  private async ensureSkillAssetsOnce(sandbox: SandboxRef) {
    const staging = this.input.skillStaging;
    if (!staging) {
      return;
    }
    let run = this.skillStagingRuns.get(sandbox.providerSandboxId);
    if (!run) {
      run = this.runSkillStaging(sandbox, staging);
      this.skillStagingRuns.set(sandbox.providerSandboxId, run);
    }
    this.latestSkillResolutions = await run;
  }

  private async runSkillStaging(
    sandbox: SandboxRef,
    staging: SandboxSkillStaging,
  ): Promise<RuntimeAssetResolution[]> {
    try {
      const plans = await staging.plans();
      if (plans.length === 0) {
        return [];
      }
      const resolutions = await ensureRuntimeAssets({
        session: this.skillStagingSession(sandbox.providerSandboxId, staging),
        assets: plans,
        ...(staging.logger ? { logger: staging.logger } : {}),
      });
      for (const resolution of resolutions) {
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
      }
      return resolutions;
    } catch (error) {
      staging.logger?.warn?.("sandbox_skill_staging_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Adapts the provider's per-file transfer surface to the runtime-asset
   * engine's session shape. Commands run through executeSystem when the
   * provider distinguishes it — staging is host-issued work, not model
   * command text.
   */
  private skillStagingSession(
    providerSandboxId: string,
    staging: SandboxSkillStaging,
  ): RuntimeAssetSessionLike {
    const provider = this.input.provider;
    const execute = provider.executeSystem
      ? provider.executeSystem.bind(provider)
      : provider.execute.bind(provider);
    return {
      rootDir: provider.pathPolicy.workspaceRoot,
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
      const inserted = await this.input.operationStore.insertRunningToolOperation({
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

    const concurrent = await this.input.operationStore.findLatestActiveToolOperation({
      context: input.context,
      operationType: input.operationType,
      toolCallId: input.toolCallId,
    });

    if (concurrent && !sameSandboxRequest(concurrent.requestJsonRedacted, request)) {
      if (
        concurrent.status === "running" &&
        concurrent.createdAt &&
        concurrent.createdAt <= staleBefore
      ) {
        const released = await this.input.operationStore.markStaleRunningToolOperationFailed({
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
      const released = await this.input.operationStore.markStaleRunningToolOperationFailed({
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

    throw new Error(`SANDBOX_OPERATION_IN_PROGRESS: sandbox ${input.operationType} is already running for this tool call.`);
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
    await this.input.operationStore.completeToolOperation({
      ...input,
      result: input.result
        ? (redactSandboxSecrets(input.result) as Record<string, unknown>)
        : undefined,
    });
    if (input.sandboxId && input.status === "succeeded") {
      await this.input.sandboxStore.touchSandbox({
        sandboxId: input.sandboxId,
        expiresAt: this.sandboxExpiresAt(),
      });
    }
  }

  async expireThreadSandbox(input: { sandboxId: string }) {
    await this.input.sandboxStore.markSandboxExpired({
      sandboxId: input.sandboxId,
    });
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
