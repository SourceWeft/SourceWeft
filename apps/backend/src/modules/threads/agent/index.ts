/**
 * Thread Agent using DeepAgent with LangGraph Checkpointer.
 *
 * This module provides the factory function for creating thread agents
 * with conversation history managed by LangGraph's PostgresSaver checkpointer.
 *
 * Note: Indexed retrieval is exposed as a tool so the agent can search the
 * current turn's visible sources when source-grounded answers need evidence.
 */

import { createDeepAgent } from "deepagents";
import type { AnyBackendProtocol, BackendFactory } from "deepagents";
import type { AgentMiddleware, InterruptOnConfig } from "langchain";
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
import { createAgentChatModel } from "../../../shared/model-gateway/index";
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
  backend?: AnyBackendProtocol | BackendFactory;
  skills?: string[];
  filesystemMounts?: AgentFilesystemMountCapability[];
  runtimePrompt?: string;
  chatProfileConfig?: unknown;
  contextCompressionReportKey?: string;
  commandExecutionPolicy?: CommandExecutionPolicy;
  extraMiddleware?: AgentMiddleware[];
  traceContext?: TraceContext;
  toolObservabilityContext?: SourceWeftToolObservabilityContext;
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
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
  params: CreateThreadAgentParams = {},
): Promise<ReturnType<typeof createDeepAgent>> {
  const checkpointer = await getChatCheckpointer();

  const modelAlias = params.modelAlias || config.chat.defaultModelAlias;
  const providerModel = params.providerModel || modelAlias;

  const model = await createAgentChatModel({
    modelAlias: providerModel,
    gatewayConfigId: params.gatewayConfigId,
    execution: {
      ...params.execution,
      ...(params.execution?.executionMode === "BYOK"
        ? {}
        : { profileAlias: params.execution?.profileAlias ?? modelAlias }),
    },
  });
  const filesystemMounts =
    params.filesystemMounts ??
    createDefaultFilesystemMounts({
      skillsEnabled: Boolean(params.skills?.length),
    });
  const middleware = await createSourceWeftAgentMiddlewareStack({
    modelAlias,
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
    model,
    tools: params.tools ?? [],
    systemPrompt: buildRuntimeSystemPrompt(params.runtimePrompt, {
      mounts: filesystemMounts,
    }),
    middleware,
    checkpointer,
    backend: params.backend as DeepAgentBackend,
    skills: params.skills,
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
