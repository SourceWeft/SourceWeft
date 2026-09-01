import type { ExecuteResponse } from "deepagents";
import type { SandboxCommandBudget } from "./command-budgets";

export const SOURCEWEFT_WORK_ROOT = "/workfiles";
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

export type SandboxExecuteResult = ExecuteResponse;

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
  createSandbox(input: CreateSandboxInput): Promise<{ id: string }>;
  getSandbox(providerSandboxId: string): Promise<unknown>;
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
  listFiles?(input: {
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
  expiresAt: Date | null;
};

export type SandboxStore = {
  findLatestActiveThreadSandbox(input: {
    provider: SandboxProviderId;
    context: SandboxRuntimeContext;
  }): Promise<SandboxRecord | null>;
  markCreatingSandboxError(input: {
    sandboxId: string;
    expectedUpdatedAt?: Date;
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
  }): Promise<void>;
  markSandboxExpired(input: { sandboxId: string }): Promise<void>;
  releaseReadyThreadSandboxLease(input: {
    context: SandboxRuntimeContext;
    expiresAt: Date;
    provider: SandboxProviderId;
    reason: string;
  }): Promise<number>;
  touchSandbox(input: { sandboxId: string; expiresAt: Date }): Promise<void>;
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
