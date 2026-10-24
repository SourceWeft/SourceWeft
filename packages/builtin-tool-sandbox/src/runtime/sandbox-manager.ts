import { randomUUID } from "node:crypto";
import {
  isSandboxInstanceMissingError,
  isSandboxProviderUnavailableError,
  isSandboxReadinessProbeFailure,
  SANDBOX_REPLACED_NOTICE,
  SANDBOX_RESTART_DETECTED_MESSAGE,
  SANDBOX_RESTARTED_NOTICE,
  SandboxInstanceChangedError,
  SandboxReplacedError,
  sandboxErrorDiagnostic,
} from "./errors";
import type {
  ExistingSandboxOperation,
  SandboxBridgeOperationType,
  SandboxCancellationReason,
  SandboxCancellationResult,
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
  /**
   * Generation lifetime of staging: aborted the moment this provider sandbox
   * is fenced, expired or forgotten, so no run (background or top-up) keeps
   * sending commands or file transfers to it. On Cloudflare a request to a
   * deleted sandbox id is not harmless — the bridge's get-or-create would
   * resurrect an untracked container.
   */
  controller: AbortController;
};

function generationStoppedReason() {
  return new DOMException(
    "Sandbox generation was invalidated; skill staging stopped.",
    "AbortError",
  );
}

function skillPlanKey(plan: RuntimeAssetPlan) {
  return `${plan.version}:${plan.sha256}`;
}

const SKILL_NAME_IN_COMMAND = /\/skills\/([a-zA-Z0-9][a-zA-Z0-9._-]*)/gu;

// Longest single provider create the manager plans for: the create call
// itself (21-70 s measured on Cloudflare, 2026-10-18) plus the provider's
// in-create readiness probe budget (90 s), plus the two POST-level retries
// (500 ms + 1500 ms + jitter) — a probe failure is never retried, see
// createProviderSandbox. ≈ 70 + 90 + 2.5 s.
export const SANDBOX_CREATE_WORST_CASE_MS = 70_000 + 90_000 + 2_500;
// How long a sibling execute waits for another call's in-flight cold start
// before giving up. Must comfortably exceed SANDBOX_CREATE_WORST_CASE_MS so
// parallel `task`/execute calls that share one thread sandbox don't fail with
// SANDBOX_CREATION_WAIT_TIMEOUT while the winner is still legitimately
// provisioning. Kept under SANDBOX_CREATING_STALE_MS so a genuinely dead
// creation is still reclaimable.
export const SANDBOX_CREATING_WAIT_TIMEOUT_MS = 180_000;
// A `creating` row that stopped being updated for this long is reclaimable by
// another worker. Exceeds the sibling wait by a full minute so a creation
// that is still legitimately running is never reclaimed by a sibling.
export const SANDBOX_CREATING_STALE_MS = 4 * 60 * 1000;
const SANDBOX_CREATING_WAIT_INTERVAL_MS = 250;
export const SANDBOX_OPERATION_STALE_GRACE_MS = 30 * 1000;
export const SANDBOX_RELEASE_LEASE_GRACE_MS = 5 * 60 * 1000;
export const SANDBOX_OPERATION_STALE_RELEASED_CODE =
  "SANDBOX_OPERATION_STALE_RELEASED";
/**
 * How many times one turn rebuilds its workspace after the provider replaced
 * the container underneath it (reportLostGeneration). Each rebuild costs a
 * create, a full re-stage and a repeat of the model's preparation, so a
 * container that keeps flapping fails closed instead of churning: the third
 * loss in a turn is SANDBOX_INSTANCE_CHANGED.
 */
export const SANDBOX_LOST_GENERATION_REPLACEMENT_LIMIT = 2;
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

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("Sandbox acquisition was cancelled.", "AbortError")
  );
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortReason(signal);
}

/** Sleep that ends early — by rejecting with the signal's reason — on abort. */
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait for a shared promise without owning it: an abort stops this caller's
 * wait but leaves the shared work (another caller's acquisition) running.
 */
function raceWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export type SandboxAcquisitionOptions = {
  waitTimeoutMs?: number;
  waitIntervalMs?: number;
  /**
   * Host invocation cancellation. The caller that starts an acquisition owns
   * it: its abort stops the sibling wait, the provider create (including the
   * provider's readiness probe) and required-asset staging, marks the
   * creating row as errored and rethrows the signal's reason — without
   * fencing or expiring anything, because nothing was handed out. A caller
   * that merely joins an acquisition in flight only stops waiting. Skill
   * staging is started by the acquisition but not owned by it (see
   * startSkillStaging), so this signal never reaches it.
   */
  signal?: AbortSignal;
};

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
    },
  ) {}

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
  /**
   * Generations (providerSandboxId) that accepted at least one operation the
   * model may rely on: a succeeded prepare/execute/collect record, or an
   * execute/file result the generation fence accepted. Host staging of
   * required assets and skill bundles is deliberately NOT recorded — it is
   * idempotent host work that a replacement generation re-runs, so it never
   * represents state the model put there. A fenced generation in this set is
   * fail-closed (SandboxInstanceChangedError); one outside it is replaced.
   */
  private readonly acceptedOperations = new Set<string>();
  /** Record id → providerSandboxId for every generation this manager handed out. */
  private readonly generationsBySandboxId = new Map<string, string>();
  /**
   * providerSandboxId → the memoized initialization that produced it, so a
   * generation reported lost mid-operation (reportLostGeneration) can drop
   * exactly its own `initializationRuns` entry and never a successor's.
   */
  private readonly generationInitializations = new Map<
    string,
    { key: string; initialization: Promise<SandboxRef> }
  >();
  /**
   * Generations a provider operation proved gone, with the verdict handed to
   * the detecting caller: one verdict per generation, however many siblings
   * report the same loss.
   */
  private readonly lostGenerations = new Map<
    string,
    SandboxReplacedError | SandboxInstanceChangedError
  >();
  private lostGenerationReplacements = 0;
  /** Set once the loss limit is hit: no generation is replaced after that. */
  private replacementsExhausted = false;
  /**
   * Set when a generation was forgotten so the next acquisition creates a
   * fresh one: the notice text the first model-visible tool result on the
   * replacement carries (see consumeReplacementNotice). Which text depends on
   * why the generation went — a timed-out stateless one (SANDBOX_REPLACED_NOTICE)
   * or one the provider replaced underneath the run (SANDBOX_RESTARTED_NOTICE).
   */
  private pendingReplacementNotice: string | null = null;
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
    options: SandboxAcquisitionOptions = {},
  ): Promise<SandboxRef> {
    const key = this.initializationKey(context);
    throwIfAborted(options.signal);
    // At most one replacement per call: a generation that is fenced again
    // right after being recreated is not a cold-start casualty.
    for (let replacements = 0; ; replacements += 1) {
      let initialization = this.initializationRuns.get(key);
      let owner = false;
      if (!initialization) {
        owner = true;
        initialization = this.initializeThreadSandbox(context, options);
        this.initializationRuns.set(key, initialization);
        const started = initialization;
        void started.catch(() => {
          // Callers already waiting share this failure (siblings must not
          // each start a sandbox after the same outage), but it is not the
          // run's verdict: a later call re-acquires, which is what makes the
          // NOT_READY "retry in a new tool call" hint — and a prefetch that
          // hit a 429 — recoverable at all.
          if (this.initializationRuns.get(key) === started) {
            this.initializationRuns.delete(key);
          }
        });
      }
      const sandbox = owner
        ? await initialization
        : await raceWithSignal(initialization, options.signal);
      this.generationsBySandboxId.set(sandbox.id, sandbox.providerSandboxId);
      this.generationInitializations.set(sandbox.providerSandboxId, {
        key,
        initialization,
      });
      if (this.invalidatedSandboxes.has(sandbox.providerSandboxId)) {
        if (
          replacements > 0 ||
          !this.forgetStatelessGeneration({
            key,
            initialization,
            sandbox,
            context,
            phase: "fence",
          })
        ) {
          throw new SandboxInstanceChangedError();
        }
        continue;
      }
      const touched = await this.acquisitionPhase(
        "renew",
        context,
        () =>
          this.input.sandboxStore.touchSandbox({
            sandboxId: sandbox.id,
            providerSandboxId: sandbox.providerSandboxId,
            expiresAt: this.sandboxExpiresAt(),
          }),
        sandbox.id,
      );
      if (touched) return sandbox;
      // The durable row is no longer ready (swept, or fenced by another
      // worker). Late results for it are rejected by the store comparison;
      // record the fence here so they are rejected without a round trip.
      this.invalidateGeneration(sandbox.providerSandboxId, "instance_changed");
      if (
        replacements > 0 ||
        !this.forgetStatelessGeneration({
          key,
          initialization,
          sandbox,
          context,
          phase: "renew",
        })
      ) {
        this.input.logWarn?.("sandbox.acquire.failed", {
          phase: "renew",
          provider: this.input.provider.id,
          ...context,
          sandboxId: sandbox.id,
          error: sandboxErrorDiagnostic(new SandboxInstanceChangedError()),
        });
        throw new SandboxInstanceChangedError();
      }
    }
  }

  /**
   * Drop a terminated generation that accepted no operation so the next
   * acquisition creates a fresh one. Returns false — and changes nothing —
   * when the generation accepted operations: the model may rely on files in
   * that /workspace, so it must fail closed instead. The old id stays in
   * `invalidatedSandboxes`; late results from it are still rejected.
   * (A generation the PROVIDER replaced is forgotten even though it accepted
   * operations — see reportLostGeneration — but never once the loss limit
   * has been spent.)
   */
  private forgetStatelessGeneration(input: {
    key: string;
    initialization: Promise<SandboxRef>;
    sandbox: SandboxRef;
    context: SandboxRuntimeContext;
    phase: "fence" | "renew";
  }): boolean {
    const generation = input.sandbox.providerSandboxId;
    if (this.replacementsExhausted || this.acceptedOperations.has(generation)) {
      return false;
    }
    this.forgetGeneration({ ...input, notice: SANDBOX_REPLACED_NOTICE });
    return true;
  }

  /**
   * The one place a generation leaves this manager's acquisition memo: its
   * initialization entry, staging state and resolutions go, so the next
   * acquisition creates a fresh generation and stages it again, and the first
   * model-visible result on that replacement carries `notice`. The old id
   * stays in `invalidatedSandboxes`; late results from it are still rejected.
   */
  private forgetGeneration(input: {
    key: string;
    initialization: Promise<SandboxRef>;
    sandbox: SandboxRef;
    context: SandboxRuntimeContext;
    phase: "fence" | "renew" | "lost";
    notice: string;
  }) {
    const generation = input.sandbox.providerSandboxId;
    if (this.initializationRuns.get(input.key) === input.initialization) {
      this.initializationRuns.delete(input.key);
    }
    this.generationInitializations.delete(generation);
    this.stopSkillStaging(generation);
    this.skillStagingStates.delete(generation);
    this.requiredAssetStagingRuns.delete(generation);
    // Conservative until the replacement stages again: /skills stays denied.
    this.latestSkillResolutions = null;
    this.latestRequiredAssetResolutions = null;
    this.pendingReplacementNotice = input.notice;
    this.input.logWarn?.("sandbox.generation.replaced", {
      phase: input.phase,
      provider: this.input.provider.id,
      ...input.context,
      sandboxId: input.sandbox.id,
      providerSandboxId: generation,
      disposition: this.invalidatedSandboxes.get(generation),
    });
  }

  /**
   * The single way a generation is fenced in this manager: record the
   * disposition late results are judged by, and stop that generation's skill
   * staging at once (see SkillStagingState.controller).
   */
  private invalidateGeneration(
    providerSandboxId: string,
    disposition: Exclude<SandboxExecutionResultDisposition, "accepted">,
  ) {
    this.invalidatedSandboxes.set(providerSandboxId, disposition);
    this.stopSkillStaging(providerSandboxId);
  }

  private stopSkillStaging(providerSandboxId: string) {
    const state = this.skillStagingStates.get(providerSandboxId);
    if (state && !state.controller.signal.aborted) {
      state.controller.abort(generationStoppedReason());
    }
  }

  /**
   * The fence recorded for a generation, or null while it is live. Callers
   * that waited for skill staging check it before running anything on the
   * generation: staging stops silently when its generation is fenced, and
   * the caller then reports the fence the same way a late result would.
   */
  generationInvalidation(
    sandbox: SandboxRef,
  ): Exclude<SandboxExecutionResultDisposition, "accepted"> | null {
    return this.invalidatedSandboxes.get(sandbox.providerSandboxId) ?? null;
  }

  /**
   * The replacement notice, exactly once after a generation was replaced
   * (`false` otherwise). Tool code attaches it to the result it is about to
   * return, so the model learns that /workspace is empty from the call that
   * first ran on the fresh generation rather than from a confusing "No such
   * file". The text says why the previous generation went: a timed-out
   * stateless one, or one the provider replaced underneath the run.
   */
  consumeReplacementNotice(): string | false {
    const pending = this.pendingReplacementNotice;
    this.pendingReplacementNotice = null;
    return pending ?? false;
  }

  /**
   * A provider operation on `sandbox` proved that its instance is gone while
   * this run still holds it: the Cloudflare adapter found the identity stamp
   * missing or mismatched inside the exec (before the command ran) or behind
   * a download miss; Daytona answered 404. The SDK restarts a container it
   * believes stopped ("Failed to check container status, assuming stopped"),
   * and the fresh one has an empty /workspace and /skills, so running on it
   * silently would hand the model a workspace it believes is populated
   * (Issue #323, 2026-10-23).
   *
   * One place decides what happens next, whatever operation detected it:
   * - the generation is fenced (late results from siblings still running on
   *   the old container are rejected, its skill staging stops) and its row
   *   expired, so no other worker hands it out again;
   * - while the turn is under SANDBOX_LOST_GENERATION_REPLACEMENT_LIMIT, the
   *   generation is forgotten — even though it accepted operations, because
   *   nothing on it survived anyway — the replacement is acquired in the
   *   background (which re-runs required-asset and skill staging), and the
   *   caller gets SandboxReplacedError to render: the detecting operation did
   *   not run, and the first result on the replacement will carry
   *   SANDBOX_RESTARTED_NOTICE;
   * - past the limit the run fails closed: SandboxInstanceChangedError, and
   *   no further generation is created this turn.
   *
   * Returns null when the generation was already fenced for another reason
   * (a cancellation deleted it, and a sibling then saw it missing); the
   * caller reports its own error, and the existing fence governs the rest.
   * Idempotent per generation: siblings that report the same loss get the
   * same verdict without a second expiry or replacement.
   */
  async reportLostGeneration(
    sandbox: SandboxRef,
    context: SandboxRuntimeContext,
    cause: unknown,
  ): Promise<SandboxReplacedError | SandboxInstanceChangedError | null> {
    const generation = sandbox.providerSandboxId;
    const known = this.lostGenerations.get(generation);
    if (known) return known;
    if (this.invalidatedSandboxes.has(generation)) return null;
    const replaced =
      !this.replacementsExhausted &&
      this.lostGenerationReplacements <
        SANDBOX_LOST_GENERATION_REPLACEMENT_LIMIT;
    const verdict = replaced
      ? new SandboxReplacedError(SANDBOX_RESTART_DETECTED_MESSAGE)
      : new SandboxInstanceChangedError(
          `The sandbox container was replaced by the provider again (${this.lostGenerationReplacements} replacement${this.lostGenerationReplacements === 1 ? "" : "s"} already in this run), so the workspace cannot keep being rebuilt.`,
        );
    this.lostGenerations.set(generation, verdict);
    // Fence before anything async: a sibling command whose result arrives
    // from the old container while the row is being expired is rejected.
    this.invalidateGeneration(generation, "instance_changed");
    this.input.logWarn?.("sandbox.generation.lost", {
      provider: this.input.provider.id,
      ...context,
      sandboxId: sandbox.id,
      providerSandboxId: generation,
      replacements: this.lostGenerationReplacements,
      replaced,
      error: sandboxErrorDiagnostic(cause),
    });
    try {
      await this.input.sandboxStore.markSandboxExpired({
        sandboxId: sandbox.id,
        providerSandboxId: generation,
        expectedStatus: "ready",
      });
    } catch (error) {
      // The in-memory fence already keeps this manager off the generation;
      // another worker that still sees the row ready expires it on its own
      // stamp check. Not a reason to withhold the verdict.
      this.input.logWarn?.("sandbox.generation.lost", {
        phase: "expire",
        provider: this.input.provider.id,
        ...context,
        sandboxId: sandbox.id,
        providerSandboxId: generation,
        error: sandboxErrorDiagnostic(error),
      });
    }
    if (!replaced) {
      this.replacementsExhausted = true;
      return verdict;
    }
    this.lostGenerationReplacements += 1;
    const memo = this.generationInitializations.get(generation);
    this.forgetGeneration({
      key: memo?.key ?? this.initializationKey(context),
      initialization: memo?.initialization ?? Promise.resolve(sandbox),
      sandbox,
      context,
      phase: "lost",
      notice: SANDBOX_RESTARTED_NOTICE,
    });
    // Same shape as the turn-start prefetch: the replacement's cold start
    // and staging overlap the model's next decision instead of being charged
    // to its next sandbox call. Its failure is that call's to re-report.
    void this.getOrCreateThreadSandbox(context).catch(() => undefined);
    return verdict;
  }

  private initializationKey(context: SandboxRuntimeContext) {
    return JSON.stringify([
      this.input.provider.id,
      context.teamId,
      context.workspaceId,
      context.threadId,
      context.runId,
      context.userId,
    ]);
  }

  private async initializeThreadSandbox(
    context: SandboxRuntimeContext,
    options: SandboxAcquisitionOptions,
  ): Promise<SandboxRef> {
    try {
      const sandbox = await this.acquireThreadSandbox(context, options);
      await this.acquisitionPhase(
        "prepare",
        context,
        async () => {
          await this.ensureRequiredAssetsOnce(sandbox, options.signal);
          throwIfAborted(options.signal);
        },
        sandbox.id,
      );
      this.startSkillStaging(sandbox, context);
      return sandbox;
    } catch (error) {
      // Whatever failed first, an aborted owner reports its own reason.
      if (options.signal?.aborted) throw abortReason(options.signal);
      throw error;
    }
  }

  private async acquireThreadSandbox(
    context: SandboxRuntimeContext,
    options: SandboxAcquisitionOptions = {},
  ): Promise<SandboxRef> {
    const signal = options.signal;
    const waitTimeoutMs =
      options.waitTimeoutMs ?? SANDBOX_CREATING_WAIT_TIMEOUT_MS;
    const waitIntervalMs =
      options.waitIntervalMs ?? SANDBOX_CREATING_WAIT_INTERVAL_MS;
    const waitStartedAt = Date.now();
    // Fenced generations this call already tried to expire; seeing one again
    // means the store is not converging and the call must fail closed.
    const expiredHere = new Set<string>();

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
              await sleep(waitIntervalMs, signal);
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
          if (this.invalidatedSandboxes.has(existing.providerSandboxId)) {
            // This manager already fenced that generation; the store still
            // says ready only because the fence write did not land. Never
            // hand it out again — expire it and look once more.
            if (expiredHere.has(existing.providerSandboxId)) {
              throw new SandboxInstanceChangedError();
            }
            expiredHere.add(existing.providerSandboxId);
            const expired = await this.input.sandboxStore.markSandboxExpired({
              sandboxId: existing.id,
              providerSandboxId: existing.providerSandboxId,
              expectedStatus: "ready",
              expectedUpdatedAt: existing.updatedAtToken ?? existing.updatedAt,
            });
            if (!expired) throw new SandboxInstanceChangedError();
            continue;
          }
          try {
            await this.acquisitionPhase(
              "check",
              context,
              () => this.checkReusableSandbox(existing.providerSandboxId),
              existing.id,
            );
          } catch (error) {
            if (!isSandboxInstanceMissingError(error)) throw error;
            const expired = await this.input.sandboxStore.markSandboxExpired({
              sandboxId: existing.id,
              providerSandboxId: existing.providerSandboxId,
              expectedStatus: "ready",
              expectedUpdatedAt: existing.updatedAtToken ?? existing.updatedAt,
            });
            // A concurrent renewal/transition won. Re-read rather than
            // creating from a stale observation of the previous generation.
            if (!expired && Date.now() - waitStartedAt >= waitTimeoutMs) {
              throw new SandboxInstanceChangedError();
            }
            continue;
          }
          // A generation found ready — created by an earlier turn or another
          // worker — may already hold files the model relies on; this manager
          // cannot know, so it is never a replacement candidate.
          this.acceptedOperations.add(existing.providerSandboxId);
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
        await sleep(waitIntervalMs, signal);
        continue;
      }

      const startedAt = Date.now();
      let providerSandboxId: string | undefined;
      try {
        throwIfAborted(signal);
        const sandbox = await this.createProviderSandbox(context, id, signal);
        providerSandboxId = sandbox.id;
        throwIfAborted(signal);
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
        if (providerSandboxId !== undefined) {
          // The container exists but its row will never be ready (abort,
          // failed health check, or another worker claimed the row). The
          // expiry sweep reclaims ready rows only and the bridge has no
          // reaper, so delete it now; best effort, the error below wins.
          try {
            await this.input.provider.deleteSandbox(providerSandboxId);
          } catch (deleteError) {
            this.input.logWarn?.("sandbox.acquire.failed", {
              phase: "delete_unready_create",
              provider: this.input.provider.id,
              ...context,
              sandboxId: id,
              providerSandboxId,
              error: sandboxErrorDiagnostic(deleteError),
            });
          }
        }
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
    signal?: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.input.provider.createSandbox({
          ttlSeconds: this.input.ttlSeconds,
          ...(signal ? { signal } : {}),
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
          !isSandboxProviderUnavailableError(error) ||
          // The container was created and probed for the full budget without
          // ever serving a command; the provider deleted it. Retrying would
          // spend another create + probe budget and blow the sibling wait.
          isSandboxReadinessProbeFailure(error)
        ) {
          throw error;
        }
        // An abort that surfaced as a provider error is not an outage.
        throwIfAborted(signal);
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
        await sleep(
          delayMs + Math.floor(Math.random() * (delayMs / 4)),
          signal,
        );
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
  private async ensureRequiredAssetsOnce(
    sandbox: SandboxRef,
    signal?: AbortSignal,
  ) {
    const staging = this.input.requiredAssetStaging;
    if (!staging) {
      return;
    }
    let run = this.requiredAssetStagingRuns.get(sandbox.providerSandboxId);
    if (!run) {
      const started = this.runRequiredAssetStaging(sandbox, staging, signal);
      run = started;
      this.requiredAssetStagingRuns.set(sandbox.providerSandboxId, started);
      void started.catch(() => {
        // An aborted staging run proves nothing about the assets; let the
        // next acquisition of this generation stage them.
        if (
          signal?.aborted &&
          this.requiredAssetStagingRuns.get(sandbox.providerSandboxId) ===
            started
        ) {
          this.requiredAssetStagingRuns.delete(sandbox.providerSandboxId);
        }
      });
    }
    this.latestRequiredAssetResolutions = await run;
  }

  private async runRequiredAssetStaging(
    sandbox: SandboxRef,
    staging: SandboxRuntimeAssetStaging,
    signal?: AbortSignal,
  ): Promise<RuntimeAssetResolution[]> {
    const plans = await staging.plans();
    throwIfAborted(signal);
    const resolutions = await ensureRuntimeAssets({
      session: this.runtimeAssetStagingSession(
        sandbox.providerSandboxId,
        staging,
        signal,
      ),
      assets: plans,
      ...(staging.logger ? { logger: staging.logger } : {}),
    });
    // The engine records an aborted command as a failed asset; the abort is
    // the real outcome.
    throwIfAborted(signal);
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
   * Start skill staging for a freshly acquired generation without making the
   * acquisition wait for it (Issue #323 B2). The turn-start prefetch acquires
   * the sandbox, so staging overlaps the model's first decision; a command
   * that never references /skills does not pay for it, and one that does
   * joins this run through `ensureSkillAssetsStaged` (the per-generation
   * tail) instead of restarting it.
   *
   * Detached from every caller: no tool call's signal reaches it. Every
   * later /skills caller of this generation depends on this run, so one tool
   * call's abort must not cancel it — each caller's signal only stops that
   * caller's own wait. What does stop it is the generation's own lifetime:
   * fencing, expiring or forgetting the generation aborts its staging
   * controller (invalidateGeneration / stopSkillStaging), so staging never
   * keeps addressing a sandbox that was cancelled or deleted. Each command
   * stays bounded by the staging command timeout. The run resolves even when
   * stopped that way; the catch is the no-unhandled-rejection guarantee, not
   * an expected path.
   *
   * Deliberate trade-off: "references /skills" is a textual check on the
   * command. A command that reaches /skills only indirectly (`bash run.sh`
   * where the script calls /skills/...) does not wait, and in the first
   * seconds of a turn it can race the staging still in flight and see a
   * missing or partial bundle directory. Before this change every first
   * command paid the whole staging time instead; commands that name /skills
   * (the documented contract) still wait for it.
   */
  private startSkillStaging(
    sandbox: SandboxRef,
    context: SandboxRuntimeContext,
  ) {
    if (!this.input.skillStaging) {
      return;
    }
    void this.ensureSkillAssetsStaged(sandbox).catch((error: unknown) => {
      this.input.logWarn?.("sandbox.skill_staging.failed", {
        provider: this.input.provider.id,
        ...context,
        sandboxId: sandbox.id,
        providerSandboxId: sandbox.providerSandboxId,
        error: sandboxErrorDiagnostic(error),
      });
    });
  }

  /**
   * Stage skill bundles into the sandbox: each bundle once per provider
   * sandbox per manager lifetime. Started (not awaited) by sandbox
   * acquisition, and called again from the execute paths whenever a command
   * references /skills — that call waits for the run already in flight and
   * then stages only what is still pending, so a bundle registered after
   * acquisition is staged on its first use and nothing is staged twice. A
   * call with nothing new costs one `plans()` read and no sandbox traffic.
   *
   * `signal` stops this caller's wait at once, and aborts only the run this
   * call itself queued (an aborted attempt is not memoized as failed). It
   * never cancels a run another caller started. Rejects only on that abort:
   * staging failure leaves the sandbox usable with /skills denied (today's
   * behavior), which the resolutions record. When the generation itself is
   * fenced mid-run, staging stops and this resolves without recording
   * anything; callers then consult generationInvalidation.
   */
  async ensureSkillAssetsStaged(sandbox: SandboxRef, signal?: AbortSignal) {
    const staging = this.input.skillStaging;
    if (!staging) {
      return;
    }
    throwIfAborted(signal);
    let state = this.skillStagingStates.get(sandbox.providerSandboxId);
    if (!state) {
      state = {
        attempts: new Map(),
        tail: Promise.resolve(),
        controller: new AbortController(),
      };
      this.skillStagingStates.set(sandbox.providerSandboxId, state);
      if (this.invalidatedSandboxes.has(sandbox.providerSandboxId)) {
        state.controller.abort(generationStoppedReason());
      }
    }
    const current = state;
    const generationSignal = current.controller.signal;
    // A run stops on its generation's fence, and additionally on the signal
    // of the caller that queued it (the background run has none).
    const runSignal = signal
      ? AbortSignal.any([signal, generationSignal])
      : generationSignal;
    // Serialized per sandbox: parallel executes share one staging directory
    // per bundle, so two concurrent runs of the same plan would race on it.
    const run = current.tail.then(() =>
      this.stagePendingSkillPlans(sandbox, staging, current, runSignal),
    );
    // Only an abort rejects a run; the tail must stay settled for the next.
    current.tail = run.catch(() => undefined);
    try {
      await raceWithSignal(run, signal);
    } catch (error) {
      // This caller's own abort is its answer.
      if (signal?.aborted) throw error;
      // The generation is gone: nothing was judged, so nothing is recorded,
      // and the caller learns of the fence through generationInvalidation.
      if (generationSignal.aborted) return;
      throw error;
    }
    // A replaced generation's late run must not speak for its replacement:
    // forgetStatelessGeneration dropped this state and reset the resolutions
    // so /skills stays denied until the new generation has staged.
    if (this.skillStagingStates.get(sandbox.providerSandboxId) !== current) {
      return;
    }
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
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      throwIfAborted(signal);
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
          signal,
        ),
        assets: pending,
        ...(staging.logger ? { logger: staging.logger } : {}),
      });
      // An aborted attempt must not be memoized as a failed bundle: the
      // bundle was never judged, and the memo would deny /skills all turn.
      throwIfAborted(signal);
      if (this.invalidatedSandboxes.has(sandbox.providerSandboxId)) {
        throw generationStoppedReason();
      }
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
      if (
        signal?.aborted ||
        this.invalidatedSandboxes.has(sandbox.providerSandboxId)
      ) {
        throw error;
      }
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
   *
   * The engine marks each command it knows to be safe to re-run
   * (`idempotent`); that verdict is forwarded to executeSystem so a provider
   * may ride out a transient SANDBOX_NOT_READY_OR_UNHEALTHY itself. The
   * manager adds no retry of its own — not for commands and not for the
   * per-file transfers below, whose transient-failure retry belongs to the
   * provider (Cloudflare retries its file PUT/GET for every caller) — so
   * attempts never multiply. The plain `execute` fallback never receives the
   * flag.
   */
  private runtimeAssetStagingSession(
    providerSandboxId: string,
    staging: SandboxRuntimeAssetStaging,
    signal?: AbortSignal,
  ): RuntimeAssetSessionLike {
    const provider = this.input.provider;
    // Belt and braces next to the generation signal: never address a fenced
    // generation, whatever signal this session was built with.
    const assertLive = () => {
      throwIfAborted(signal);
      if (this.invalidatedSandboxes.has(providerSandboxId)) {
        throw generationStoppedReason();
      }
    };
    return {
      rootDir: provider.pathPolicy.workspaceRoot,
      skillsRoot: provider.pathPolicy.skillsRoot,
      checksumCommand: provider.id === "local" ? "shasum -a 256" : undefined,
      execute: async (command, options) => {
        assertLive();
        const input = {
          providerSandboxId,
          command,
          timeoutMs: staging.commandTimeoutMs,
          maxOutputChars: staging.maxOutputChars,
          ...(signal ? { signal } : {}),
        };
        const result = provider.executeSystem
          ? await provider.executeSystem({
              ...input,
              ...(options?.idempotent === true ? { idempotent: true } : {}),
            })
          : await provider.execute(input);
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
          assertLive();
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
          assertLive();
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
      // A succeeded tool operation is state the model may rely on (a prepare
      // that uploaded files, an execute that wrote outputs); a recoverable
      // failure recorded under the same status counts too, since a partial
      // upload may have landed. From here on this generation fails closed.
      const generation = this.generationsBySandboxId.get(input.sandboxId);
      if (generation) this.acceptedOperations.add(generation);
    }
    await this.input.operationStore.completeToolOperation({
      ...input,
      result: input.result
        ? (redactSandboxSecrets(input.result) as Record<string, unknown>)
        : undefined,
    });
  }

  async expireThreadSandbox(input: { sandboxId: string }) {
    // The expiry sweep deletes an expired row's container; staging must not
    // outlive the row it was staging for.
    const generation = this.generationsBySandboxId.get(input.sandboxId);
    if (generation) this.stopSkillStaging(generation);
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
    const disposition = await this.resolveDispositionAgainstFence(
      sandbox,
      context,
    );
    // The caller is about to hand the model a result produced on this
    // generation; from now on it cannot be replaced silently.
    if (disposition === "accepted") {
      this.acceptedOperations.add(sandbox.providerSandboxId);
    }
    return disposition;
  }

  private async resolveDispositionAgainstFence(
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
    let persistentFenceConfirmed = true;
    if (sandboxScoped) {
      // Persist the generation fence before asking the provider to terminate.
      // That ordering lets managers in other turns/processes reject late bytes
      // while physical deletion is still in flight.
      this.invalidateGeneration(
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
      this.invalidateGeneration(
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
          this.invalidateGeneration(
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
