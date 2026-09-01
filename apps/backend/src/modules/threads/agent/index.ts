/**
 * Thread Agent using DeepAgent with LangGraph Checkpointer.
 *
 * This module provides the factory function for creating thread agents
 * with conversation history managed by LangGraph's PostgresSaver checkpointer.
 *
 * Note: Indexed retrieval is exposed as a tool so the agent can search the
 * current turn's visible sources when source-grounded answers need evidence.
 */

import { createDeepAgent, StateBackend } from "deepagents";
import type {
  AnyBackendProtocol,
  AnySubAgent,
  FilesystemPermission,
} from "deepagents";
import type { AgentMiddleware, InterruptOnConfig } from "langchain";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { LangChainModelExecutionConfig } from "@sourceweft/model-gateway";
import { buildRuntimeSystemPrompt } from "./prompts";
import {
  createDefaultFilesystemMounts,
  type AgentFilesystemMountCapability,
} from "./filesystem-capabilities";
import {
  createCommandToolChoiceMiddleware,
  createSourceWeftAgentMiddlewareStack,
  forcedToolChoice,
  hasToolCallNamed,
  messageToolCalls,
  sanitizeMessagesForHistory,
  type CommandExecutionPolicy,
  type SourceWeftToolObservabilityContext,
} from "./middleware";
import { getChatCheckpointer } from "../../../shared/chat-checkpointer";
import { config } from "../../../shared/config";
import type { TraceContext } from "../../llm-observability";

type DeepAgentBackend = NonNullable<
  Parameters<typeof createDeepAgent>[0]
>["backend"];

export interface CreateThreadAgentParams {
  /** The model alias to use (e.g., "chat-default") */
  modelAlias?: string;
  providerModel?: string;
  gatewayConfigId?: string | null;
  execution?: LangChainModelExecutionConfig;
  tools?: Array<ClientTool | ServerTool>;
  backend?: AnyBackendProtocol;
  /**
   * Purpose-built subagents exposed to the model through the `task` tool. When
   * omitted, deepagents still provides the general-purpose delegate; these are
   * additional named delegates (e.g. `explore`, `plan`). Each inherits the billed
   * gateway `model` unless it overrides it, so child model calls stay billed.
   */
  subagents?: AnySubAgent[];
  skills?: string[];
  filesystemMounts?: AgentFilesystemMountCapability[];
  permissions?: FilesystemPermission[];
  runtimePrompt?: string;
  chatProfileConfig?: unknown;
  contextCompressionReportKey?: string;
  commandExecutionPolicy?: CommandExecutionPolicy;
  extraMiddleware?: AgentMiddleware[];
  traceContext?: TraceContext;
  toolObservabilityContext?: SourceWeftToolObservabilityContext;
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
  /**
   * The chat model to drive the agent with.
   *
   * Required, and supplied by the billed gateway wrapper, so that a thread
   * agent cannot be created with a model that settles against no billing scope.
   */
  model: BaseLanguageModel;
}

/**
 * Create a deep agent for thread streaming with checkpointer support.
 *
 * The checkpointer persists conversation state between calls using the thread_id.
 * This enables multi-turn dialogue continuity without manual history management.
 *
 * @param params - Agent creation parameters
 * @returns A configured DeepAgent instance with PostgresSaver checkpointer
 */
export async function createThreadAgent(
  params: CreateThreadAgentParams,
): Promise<ReturnType<typeof createDeepAgent>> {
  const checkpointer = await getChatCheckpointer();

  const modelAlias = params.modelAlias || config.chat.defaultModelAlias;
  const providerModel = params.providerModel || modelAlias;
  const backend = params.backend ?? new StateBackend();

  const filesystemMounts =
    params.filesystemMounts ??
    createDefaultFilesystemMounts({
      skillsEnabled: Boolean(params.skills?.length),
    });
  const middleware = await createSourceWeftAgentMiddlewareStack({
    backend,
    modelAlias,
    model: params.model,
    gatewayConfigId: params.gatewayConfigId,
    execution: params.execution,
    chatProfileConfig: params.chatProfileConfig,
    contextCompressionReportKey: params.contextCompressionReportKey,
    commandExecutionPolicy: params.commandExecutionPolicy,
    extraMiddleware: params.extraMiddleware,
    filesystemMounts,
    toolObservabilityContext: params.toolObservabilityContext,
    traceContext: params.traceContext,
  });

  const agent = createDeepAgent({
    model: params.model,
    tools: params.tools ?? [],
    systemPrompt: buildRuntimeSystemPrompt(params.runtimePrompt, {
      mounts: filesystemMounts,
    }),
    middleware,
    checkpointer,
    backend: backend as DeepAgentBackend,
    ...(params.subagents ? { subagents: params.subagents } : {}),
    skills: params.skills,
    permissions: params.permissions,
    interruptOn: params.interruptOn,
  });

  return agent;
}

export type { CommandExecutionPolicy } from "./middleware";

/**
 * Build the config for agent invocation with checkpointer thread_id.
 * This maps the agent's conversation state to the thread record.
 */
export function buildAgentConfig(
  threadId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    configurable: {
      thread_id: threadId,
      ...extra,
    },
  };
}

export const testExports = {
  createCommandToolChoiceMiddleware,
  forcedToolChoice,
  hasToolCallNamed,
  messageToolCalls,
  sanitizeMessagesForHistory,
};

/**
 * Cross-subdomain surface toward the sibling subdomains `durable/` and
 * `stream/` (T2.3): the members they actually reference, re-exported so
 * those imports can come through this index instead of deep paths. The
 * boundary is enforced by `../architecture.test.ts`; the deep imports that
 * predate it are frozen in that test's ALLOWED_CROSS_IMPORTS table and
 * should migrate here. Only members a sibling references belong in this
 * block — it is not a barrel for the whole directory.
 */
export type { AgentCitation } from "./citation-registry";
export { agentSandboxService } from "./sandbox-service/service";
// Type-only on purpose: a value re-export of turn/runner here would close a
// runtime cycle (agent/index → turn/runner → turn/checkpoint → agent/index).
// Callers of invokeDeepAgentTurn keep the deep import, recorded with this
// reason in ../architecture.test.ts's exemption table.
export type { DeepAgentTurnEvent, DeepAgentTurnOutcome } from "./turn/runner";
export { DEEPAGENTS_WRITE_TODOS_TOOL_NAME } from "./turn/tool-tracker";
// Safe as a value re-export: turn/thinking's only turn-external import is
// type-only, so unlike turn/runner this closes no runtime cycle.
export { appendReasoningChunk } from "./turn/thinking";
export {
  AGENT_TOOL_TERMINATION_UNKNOWN_CODE,
  AgentToolTerminationUnknownError,
  findAgentToolTerminationUnknownReason,
} from "./middleware/tool-execution-timeout";
