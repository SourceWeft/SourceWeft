export {
  collectSandboxOutputsAgentTool,
  executeAgentTool,
  prepareSandboxWorkspaceAgentTool,
  sandboxAgentToolDefs,
} from "./agent-tool-defs";

import { builtinSandboxCapabilityManifest } from "./manifest";
import {
  buildSandboxToolDescriptions,
  collectSandboxOutputsSchema,
  prepareSandboxWorkspaceSchema,
  sandboxToolDescriptions,
  sandboxToolInterruptDescriptions,
} from "./sandbox-tools";
import { buildSandboxRuntimePrompt } from "./runtime-prompt";
import { createSandboxInterruptConfigs } from "./runtime/sandbox-interrupts";
import {
  SANDBOX_OPERATION_STALE_GRACE_MS,
  SANDBOX_OPERATION_STALE_RELEASED_CODE,
  SANDBOX_RELEASE_LEASE_GRACE_MS,
  SandboxManager,
  resolveSandboxToolOperationReplay,
  stableSandboxRequestJson,
} from "./runtime/sandbox-manager";
import {
  DEFAULT_SANDBOX_COMMAND_BUDGET,
  SANDBOX_COMMAND_BUDGETS,
  maxSandboxCommandTimeoutMs,
  resolveSandboxCommandTimeoutMs,
} from "./runtime/command-budgets";
import type { SandboxCommandBudget } from "./runtime/command-budgets";
import { createSandboxRuntimeForTurn } from "./runtime/runtime";
import { createSandboxTools } from "./runtime/sandbox-tools";
import { SourceWeftSandboxBackend } from "./runtime/sourceweft-sandbox-backend";
import {
  SOURCEWEFT_VFS_ROOT_POLICY,
  assertCollectSandboxPath,
  assertExecuteCommandPathPolicy,
  assertExecuteCwd,
  assertSandboxFilePath,
  assertPrepareSandboxPath,
  assertSandboxReadPath,
  assertSandboxWritePath,
  assertSourceWorkPath,
  dirname,
  shellQuote,
} from "./runtime/paths";
import {
  redactSandboxOperationRequest,
  redactSandboxSecrets,
  redactSandboxText,
  sandboxRequestFingerprint,
} from "./runtime/redaction";
import { SOURCEWEFT_KB_ROOT, SOURCEWEFT_WORK_ROOT } from "./runtime/types";
import type {
  CollectSandboxOutputsInput,
  PrepareSandboxWorkspaceInput,
} from "./sandbox-tools";
import type { SandboxRuntimePromptCapabilities } from "./runtime-prompt";
import type { SandboxRuntimeForTurn } from "./runtime/runtime";
import type { SandboxRootPolicy } from "./runtime/paths";
import type {
  ExistingSandboxOperation,
  SandboxBridgeOperationType,
  SandboxCollectedOutput,
  SandboxExecuteResult,
  SandboxOperationStatus,
  SandboxOperationStore,
  SandboxOperationType,
  SandboxPreparedFile,
  SandboxProvider,
  SandboxProviderId,
  SandboxProviderPathPolicy,
  SandboxRecord,
  SandboxRef,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStatus,
  SandboxStore,
} from "./runtime/types";

export const builtinSandboxCapability = {
  id: "sourceweft/sandbox",
} as const;

export { builtinSandboxCapabilityManifest };
export {
  collectSandboxOutputsSchema,
  prepareSandboxWorkspaceSchema,
  buildSandboxToolDescriptions,
  buildSandboxRuntimePrompt,
  sandboxToolDescriptions,
  sandboxToolInterruptDescriptions,
};
export {
  DEFAULT_SANDBOX_COMMAND_BUDGET,
  SANDBOX_COMMAND_BUDGETS,
  maxSandboxCommandTimeoutMs,
  resolveSandboxCommandTimeoutMs,
  createSandboxInterruptConfigs,
  SANDBOX_OPERATION_STALE_GRACE_MS,
  SANDBOX_OPERATION_STALE_RELEASED_CODE,
  SANDBOX_RELEASE_LEASE_GRACE_MS,
  SandboxManager,
  resolveSandboxToolOperationReplay,
  stableSandboxRequestJson,
  createSandboxRuntimeForTurn,
  createSandboxTools,
  SourceWeftSandboxBackend,
  SOURCEWEFT_VFS_ROOT_POLICY,
  assertCollectSandboxPath,
  assertExecuteCommandPathPolicy,
  assertExecuteCwd,
  assertSandboxFilePath,
  assertPrepareSandboxPath,
  assertSandboxReadPath,
  assertSandboxWritePath,
  assertSourceWorkPath,
  dirname,
  shellQuote,
  redactSandboxOperationRequest,
  redactSandboxSecrets,
  redactSandboxText,
  sandboxRequestFingerprint,
};
export type {
  SandboxCommandBudget,
  CollectSandboxOutputsInput,
  PrepareSandboxWorkspaceInput,
  SandboxRuntimePromptCapabilities,
  SandboxRuntimeForTurn,
  SandboxRootPolicy,
  ExistingSandboxOperation,
  SandboxBridgeOperationType,
  SandboxCollectedOutput,
  SandboxExecuteResult,
  SandboxOperationStatus,
  SandboxOperationStore,
  SandboxOperationType,
  SandboxPreparedFile,
  SandboxProvider,
  SandboxProviderId,
  SandboxProviderPathPolicy,
  SandboxRecord,
  SandboxRef,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStatus,
  SandboxStore,
};
export { SOURCEWEFT_KB_ROOT, SOURCEWEFT_WORK_ROOT };
export {
  AgentSandboxService,
  SandboxRuntimeConfigurationError,
} from "./sandbox-service";
export type {
  AgentSandboxServiceDeps,
  AgentSandboxRuntimeForTurn,
  SandboxRuntimeName,
  SandboxRuntimeRequest,
} from "./sandbox-service";
export type {
  SandboxProviderConfigurationStatus,
  SandboxProviderFactory,
  SandboxServiceConfig,
} from "./runtime/types";
export type {
  CreateSandboxProviderFactories,
  CreateSandboxProviderFactoriesInput,
  SandboxProviderHostLimits,
} from "./capability-host-service";
export {
  EXECUTE_TOOL_NAME,
  PREPARE_SANDBOX_TOOL_NAME,
  COLLECT_SANDBOX_OUTPUTS_TOOL_NAME,
} from "./agent-tool-defs";
