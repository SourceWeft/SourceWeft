import type { ExecuteResponse } from "deepagents";
import type { SandboxCommandDurability } from "@sourceweft/contracts/agent-tools";
export type { SandboxCommandDurability } from "@sourceweft/contracts/agent-tools";
import type { SandboxCommandBudget } from "./command-budgets";

export const SOURCEWEFT_WORK_ROOT = "/files";
export const SOURCEWEFT_KB_ROOT = "/kb";
/**
 * Platform skill-staging contract root (docs/architecture/sandbox-skill-staging.md).
 *
 * Unlike the two roots above — which are DB-backed VFS namespaces that never
 * exist inside the provider sandbox — /skills is BOTH the VFS view of skill
 * bundles (file tools) and, when staging succeeds, a real sandbox directory
 * holding byte-identical staged copies. Execute commands may reference it only
 * after staging resolved; path-level asserts (cwd/prepare/collect) always
 * treat it as platform-owned and deny writes.
 */
export const SOURCEWEFT_SKILLS_ROOT = "/skills";

export type SandboxBridgeOperationType = "prepare" | "execute" | "collect";
export type SandboxOperationType =
  SandboxBridgeOperationType | "create" | "close" | "cleanup";

export type SandboxOperationStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type SandboxStatus =
  "creating" | "ready" | "expired" | "closed" | "error";

export type SandboxProviderId = string;

export type SandboxProviderPathPolicy = {
  /** Host-local skill files may live under the bound workspace instead of /skills. */
  skillsRoot?: string;
  workspaceRoot: string;
  defaultCwd: string;
  prepareTargetRoots: readonly string[];
  collectSourceRoots: readonly string[];
  readWriteRoots: readonly string[];
};

export type SandboxRef = {
  id: string;
  provider: SandboxProviderId;
  providerSandboxId: string;
};

export type SandboxExecuteResult = ExecuteResponse & {
  durability?: SandboxCommandDurability;
};

/**
 * Persistent-volume integration (packages/sandbox-volume). The manager calls these at five
 * points of the sandbox lifecycle; everything else about volumes stays behind this interface.
 * Absent → sandboxes behave exactly as before.
 */
export type SandboxVolumeExecutor = {
  execute(
    command: string,
    options: { timeoutMs: number },
  ): Promise<{ output: string; exitCode: number | null }>;
};

export type SandboxVolumeScope = {
  teamId: string;
  workspaceId: string;
  threadId: string;
};

export type SandboxSupervisorIdentity = {
  protocolVersion: 1;
  boundary: "pid-namespace";
  protectedControl: true;
  bootId: string;
  supervisorNonce: string;
  /** Signal-based pauses do not establish a persistence barrier. No shipped provider implements this capability. */
  stableFreeze:
    | {
        available: false;
        mechanism: "none" | "signal-pause" | "cgroup-v2-freezer";
        kernelIoQuiescence?: "unqualified";
      }
    | {
        available: true;
        mechanism: "cgroup-v2-freezer";
        kernelEnforced: true;
        kernelIoQuiescence: "qualified";
      };
};

/** Narrow host-only RPC; this surface never accepts shell commands or arbitrary paths. */
export type SandboxVolumeControl = {
  identity(input: {
    providerSandboxId: string;
  }): Promise<SandboxSupervisorIdentity>;
  freeze(input: {
    providerSandboxId: string;
    expectedNonce: string;
    freezeId: string;
  }): Promise<{
    freezeId: string;
    supervisorNonce: string;
    allWritersStopped: true;
    mechanism: "cgroup-v2-freezer";
    kernelEnforced: true;
    kernelIoQuiescent: true;
  }>;
  /** Production barrier release only. The current supervisor's diagnostic pause/thaw RPCs do not satisfy this contract. */
  resume(input: {
    providerSandboxId: string;
    expectedNonce: string;
    freezeId: string;
  }): Promise<void>;
  flush(input: {
    providerSandboxId: string;
    expectedNonce: string;
    attachmentId: string;
    freezeId?: string;
    drainId?: string;
    full: true;
  }): Promise<{ output: string; exitCode: number | null }>;
  drain(input: {
    providerSandboxId: string;
    expectedNonce: string;
    drainId: string;
  }): Promise<{
    drainId: string;
    bootId: string;
    supervisorNonce: string;
    launchGateClosed: true;
    allNamespacesExited: true;
  }>;
};

export type SandboxVolumeHooks = {
  /** Set only by the typed protected bootstrap implementation, never legacy workspace metadata hooks. */
  protectedBootstrap?: true;
  acquireOperation?(input: {
    attachmentId: string;
    operationId: string;
    sandboxId: string;
    bootId: string;
    supervisorNonce: string;
    writerKind?: "external" | "supervised";
  }): Promise<{ permitId: string; reused: boolean }>;
  markOperationStarted?(input: {
    attachmentId: string;
    permitId: string;
  }): Promise<boolean>;
  releaseOperation?(
    input: { attachmentId: string; permitId: string } & (
      | { outcome: "not_started" }
      | { outcome: "persisted"; confirmedSeq: number }
    ),
  ): Promise<void>;
  assertActive(input: {
    attachmentId: string;
    executor: SandboxVolumeExecutor;
  }): Promise<void>;
  quarantine(input: { attachmentId: string; reason: string }): Promise<void>;
  attach(input: {
    scope: SandboxVolumeScope;
    sandboxId: string;
    executor: SandboxVolumeExecutor;
  }): Promise<{ attachmentId: string }>;
  wrapCommand(command: string, options?: { full?: boolean }): string;
  parseResult(input: {
    attachmentId: string;
    output: string;
    exitCode: number | null;
    executor: SandboxVolumeExecutor;
  }): Promise<{
    output: string;
    exitCode: number | null;
    sync: {
      persisted: boolean;
      confirmedSeq?: number;
      mode?: "shadow" | "full";
    };
  }>;
  checkpoint(input: {
    attachmentId: string;
    executor: SandboxVolumeExecutor;
    freezeId?: string;
    drainId?: string;
    supervisorNonce?: string;
    trustedFlush?: (input: {
      attachmentId: string;
      freezeId?: string;
      drainId?: string;
    }) => Promise<{ output: string; exitCode: number | null }>;
  }): Promise<{
    sync: {
      persisted: boolean;
      confirmedSeq?: number;
      mode?: "shadow" | "full";
    };
  }>;
  /** Checkpoint for a sandbox this process did not attach (cleanup workers); null when the thread has no volume. */
  checkpointScope(input: {
    scope: SandboxVolumeScope;
    sandboxId: string;
    executor: SandboxVolumeExecutor;
  }): Promise<{ sync: { persisted: boolean } } | null>;
  onContainerReplaced(input: {
    scope: SandboxVolumeScope;
    sandboxId: string;
    /** Provider-confirmed missing old instance, or the refused command's same instance ID. */
    previousSandboxId?: string;
    executor: SandboxVolumeExecutor;
  }): Promise<{ attachmentId: string }>;
  isContainerReplacedError(error: unknown): boolean;
};

export type SandboxCancellationReason = "user_cancelled" | "timed_out";

/**
 * Physical provider-termination outcome. `confirmed: false` deliberately has
 * no best-guess mode: closing a client stream is not proof that either the
 * command or its sandbox stopped.
 */
export type SandboxCancellationResult =
  | { confirmed: true; mode: "command" | "sandbox" }
  | { confirmed: false; mode: "unknown" };

export type SandboxCancelExecutionInput = {
  providerSandboxId: string;
  /** Host-issued identity; never accepted from model/tool arguments. */
  executionId: string;
  reason: SandboxCancellationReason;
};

export type SandboxPreparedFile = {
  sourcePath: string;
  sandboxPath: string;
  sizeBytes: number;
};

export type SandboxCollectedOutput = {
  sandboxPath: string;
  targetKind: "workfile" | "artifact";
  targetPath?: string;
  sizeBytes: number;
};

export type SandboxRuntimeContext = {
  localCaller?: { sessionId: string; nativeAccessId?: string };
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  messageId: string;
  runId: string;
  sandboxExecuteToolCallId?: string;
};

export type SandboxRuntimeLimits = {
  ttlSeconds: number;
  /**
   * One timeout per class of operation (see `command-budgets.ts`) rather than
   * one number plus overrides: a caller picks a class, it cannot pick a
   * duration. There is deliberately no per-command timeout anywhere in this
   * type — that is what keeps the budget out of reach of tool input.
   */
  commandBudgetsMs: Readonly<Record<SandboxCommandBudget, number>>;
  /** Absolute cap applied to every budget, however it was configured. */
  maxCommandTimeoutMs: number;
  maxOutputChars: number;
  maxPrepareFileBytes: number;
  maxPrepareTotalBytes: number;
  maxCollectFileBytes: number;
  maxCollectTotalBytes: number;
};

/**
 * Sandbox network-isolation profile (docs/architecture/skill-registry-index.md
 * §6b/§7.0). Two off-host isolation profiles ride on the same provider:
 * - `default`          — provider default egress (existing behavior).
 * - `ingestion-github` — egress restricted to the GitHub fetch hosts
 *   (github.com / codeload.github.com / raw.githubusercontent.com) used by the
 *   submit-time fetch+extract session; runs no skill code.
 * - `block-all`        — no network access at all (Daytona `networkBlockAll`)
 *   for the run-time execution session.
 *
 * The selected value is persisted on `agent_sandboxes.network_policy`; the
 * provider adapter translates it into provider-native parameters at create
 * time (see the Daytona adapter's `resolveDaytonaNetworkPolicyOptions`).
 */
export type SandboxNetworkPolicy = "default" | "ingestion-github" | "block-all";

export type CreateSandboxInput = {
  labels: Record<string, string>;
  snapshot?: string;
  ttlSeconds: number;
  /**
   * Network isolation profile for this sandbox. Omitted / `undefined` behaves
   * as `default` (provider default egress). See `SandboxNetworkPolicy`.
   */
  networkPolicy?: SandboxNetworkPolicy;
};

export type SandboxProvider = {
  id: SandboxProviderId;
  pathPolicy: SandboxProviderPathPolicy;
  /**
   * Scope the provider can guarantee when cancellation begins. Omitted is
   * conservatively sandbox-scoped. A command-scoped provider must declare this
   * explicitly so the durable generation fence does not quarantine siblings.
   */
  cancellationScope?: "command" | "sandbox";
  /** Separately authenticated privileged volume control, never exposed through generic execution/file APIs. */
  volumeControl?: SandboxVolumeControl;
  /** Executes only inside the registered workload namespace/UID; never an arbitrary privileged shell. */
  executeSupervised?(
    input: Parameters<SandboxProvider["execute"]>[0] & {
      expectedNonce: string;
    },
  ): Promise<SandboxExecuteResult>;
  createSandbox(input: CreateSandboxInput): Promise<{ id: string }>;
  /** Must verify reusability when no stronger health check is declared. */
  getSandbox(providerSandboxId: string): Promise<unknown>;
  /** A complete reusability check, including existence; replaces getSandbox. */
  checkSandboxHealth?(providerSandboxId: string): Promise<unknown>;
  deleteSandbox(providerSandboxId: string): Promise<unknown>;
  /**
   * Provider-native physical cancellation. Providers without this method are
   * terminated by deleting their sandbox in `SandboxManager`.
   */
  cancelExecution?(
    input: SandboxCancelExecutionInput,
  ): Promise<SandboxCancellationResult>;
  execute(input: {
    providerSandboxId: string;
    executionId?: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecuteResult>;
  executeSystem?(input: {
    providerSandboxId: string;
    executionId?: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecuteResult>;
  uploadFile(input: {
    providerSandboxId: string;
    sandboxPath: string;
    content: Uint8Array;
  }): Promise<unknown>;
  downloadFile(input: {
    providerSandboxId: string;
    executionId?: string;
    sandboxPath: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<Buffer>;
  /** Native I/O enforces bound-root/no-follow access itself; downloads return
   * bounded immutable snapshots and must reject unsafe links and file races. */
  nativeFileOperations?: boolean;
  listFiles?(input: {
    recursive?: boolean;
    providerSandboxId: string;
    sandboxPath: string;
  }): Promise<
    Array<{
      path: string;
      is_dir?: boolean;
      size?: number;
      modified_at?: string;
    }>
  >;
  readTextFile?(input: {
    providerSandboxId: string;
    sandboxPath: string;
  }): Promise<string>;
  replaceTextFile?(input: {
    providerSandboxId: string;
    sandboxPath: string;
    content: string;
    expected: string;
  }): Promise<unknown>;
  writeTextFile?(input: {
    providerSandboxId: string;
    sandboxPath: string;
    content: string;
  }): Promise<unknown>;
  editTextFile?(input: {
    providerSandboxId: string;
    sandboxPath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }): Promise<{ occurrences: number }>;
  grepFiles?(input: {
    providerSandboxId: string;
    pattern: string;
    sandboxPath?: string | null;
    glob?: string | null;
  }): Promise<
    Array<{
      path: string;
      line: number;
      text: string;
    }>
  >;
  nativeGrep?(input: {
    providerSandboxId: string;
    paths: string[];
    pattern: string;
    literal?: boolean;
    ignoreCase?: boolean;
    firstPerFile?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    matches: Array<{ path: string; line: number; text: string }>;
    visitedPaths: string[];
    skipped: string[];
    truncated: boolean;
  }>;
  globFiles?(input: {
    providerSandboxId: string;
    pattern: string;
    sandboxPath?: string;
  }): Promise<
    Array<{
      path: string;
      is_dir?: boolean;
      size?: number;
      modified_at?: string;
    }>
  >;
  ensureDirectory(input: {
    providerSandboxId: string;
    directory: string;
  }): Promise<unknown>;
};

export type SandboxRecord = {
  id: string;
  provider: SandboxProviderId;
  providerSandboxId: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  status: SandboxStatus;
  updatedAt: Date;
  /** Exact database timestamp for conditional writes; Date loses sub-ms precision. */
  updatedAtToken?: string;
  expiresAt: Date | null;
};

export type SandboxStore = {
  findLatestActiveThreadSandbox(input: {
    provider: SandboxProviderId;
    context: SandboxRuntimeContext;
  }): Promise<SandboxRecord | null>;
  markCreatingSandboxError(input: {
    sandboxId: string;
    expectedUpdatedAt?: Date | string;
  }): Promise<boolean>;
  insertCreatingSandbox(input: {
    sandboxId: string;
    provider: SandboxProviderId;
    providerSandboxId: string;
    context: SandboxRuntimeContext;
    expiresAt: Date;
  }): Promise<boolean>;
  markSandboxReady(input: {
    sandboxId: string;
    providerSandboxId: string;
    expiresAt: Date;
  }): Promise<boolean>;
  markSandboxExpired(input: {
    sandboxId: string;
    providerSandboxId?: string;
    expectedStatus?: SandboxStatus;
    expectedUpdatedAt?: Date | string;
  }): Promise<boolean>;
  releaseReadyThreadSandboxLease(input: {
    context: SandboxRuntimeContext;
    expiresAt: Date;
    provider: SandboxProviderId;
    reason: string;
  }): Promise<number>;
  touchSandbox(input: {
    sandboxId: string;
    providerSandboxId?: string;
    expiresAt: Date;
  }): Promise<boolean>;
};

export type ExistingSandboxOperation = {
  id?: string;
  createdAt?: Date;
  messageId?: string;
  status: "running" | "succeeded" | "failed";
  requestJsonRedacted: Record<string, unknown>;
  resultJsonRedacted: Record<string, unknown>;
};

export type SandboxOperationTimelineItem = {
  operationType: SandboxOperationType;
  status: SandboxOperationStatus;
  durationMs: number | null;
  createdAt: string;
  result: Record<string, unknown>;
};

export type SandboxOperationStore = {
  listMessageOperations(input: {
    context: SandboxRuntimeContext;
    limit: number;
  }): Promise<SandboxOperationTimelineItem[]>;
  findLatestToolOperation(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
    statuses: Array<"running" | "succeeded" | "failed">;
  }): Promise<ExistingSandboxOperation | null>;
  insertRunningToolOperation(input: {
    operationId: string;
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
    request: Record<string, unknown>;
  }): Promise<boolean>;
  findLatestActiveToolOperation(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
  }): Promise<ExistingSandboxOperation | null>;
  markStaleRunningToolOperationFailed(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    staleBefore: Date;
    toolCallId: string;
    result: Record<string, unknown>;
  }): Promise<boolean>;
  completeToolOperation(input: {
    operationId: string;
    sandboxId?: string | null;
    status: "succeeded" | "failed";
    result?: Record<string, unknown>;
    durationMs?: number;
  }): Promise<void>;
  recordOperation(input: {
    operationId: string;
    context: SandboxRuntimeContext;
    sandboxId?: string | null;
    operationType: SandboxOperationType;
    status: SandboxOperationStatus;
    toolCallId?: string | null;
    request?: Record<string, unknown>;
    result?: Record<string, unknown>;
    durationMs?: number;
  }): Promise<void>;
  findSucceededOperationByToolCall(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
  }): Promise<{ result: Record<string, unknown> } | null>;
};

// ---- Sandbox service types ----

export type SandboxProviderConfigurationStatus = {
  configured: boolean;
  missing: string[];
  metadata?: Record<string, unknown>;
};

export type SandboxProviderFactory = {
  id: string;
  createProvider(): SandboxProvider;
  getConfigurationStatus(): SandboxProviderConfigurationStatus;
};

export type SandboxServiceConfig = {
  enabled: boolean;
  toolApprovalEnabled: boolean;
  provider: string;
  limits: SandboxRuntimeLimits;
};
