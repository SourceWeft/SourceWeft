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
import type { AnyBackendProtocol } from "deepagents";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import type { LangChainModelExecutionConfig } from "@sourceweft/model-gateway";
import { buildRuntimeSystemPrompt } from "./prompts";
import {
  buildFilesystemToolDescriptions,
  createDefaultFilesystemMounts,
  type AgentFilesystemMountCapability,
} from "./filesystem-capabilities";
import { createSourceWeftContextCompressionMiddleware } from "./context-compression";
import { getChatCheckpointer } from "../../../shared/chat-checkpointer";
import { createAgentChatModel } from "../../../shared/model-gateway/index";
import type { TraceContext } from "../../../shared/llm-observability";

function createKnowledgeFilesystemToolDescriptionMiddleware(input: {
  mounts: AgentFilesystemMountCapability[];
}) {
  const descriptions = buildFilesystemToolDescriptions({ mounts: input.mounts });
  const setToolDescription = (tool: { description?: string }, description: string) => {
    tool.description = description;
    return tool;
  };

  return createMiddleware({
    name: "SourceWeftKnowledgeFilesystemDescriptions",
    wrapModelCall: async (request, handler) => {
      const tools = request.tools.map((tool) => {
        const description =
          descriptions[tool.name as keyof typeof descriptions];
        return description ? setToolDescription(tool, description) : tool;
      });

      return handler({
        ...request,
        tools,
      });
    },
  });
}

export interface CreateThreadAgentParams {
  /** The model alias to use (e.g., "chat-default") */
  modelAlias?: string;
  gatewayConfigId?: string | null;
  execution?: LangChainModelExecutionConfig;
  tools?: Array<ClientTool | ServerTool>;
  backend?: AnyBackendProtocol;
  skills?: string[];
  filesystemMounts?: AgentFilesystemMountCapability[];
  runtimePrompt?: string;
  chatProfileConfig?: unknown;
  contextCompressionReportKey?: string;
  traceContext?: TraceContext;
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
export async function createThreadAgent(params: CreateThreadAgentParams = {}): Promise<ReturnType<typeof createDeepAgent>> {
  const checkpointer = await getChatCheckpointer();

  const modelAlias = params.modelAlias || "chat-default";

  const model = await createAgentChatModel({
    modelAlias,
    gatewayConfigId: params.gatewayConfigId,
    execution: params.execution,
  });
  const contextCompressionMiddleware =
    await createSourceWeftContextCompressionMiddleware({
      modelAlias,
      gatewayConfigId: params.gatewayConfigId,
      execution: params.execution,
      chatProfileConfig: params.chatProfileConfig,
      reportKey: params.contextCompressionReportKey,
      traceContext: params.traceContext,
    });
  const filesystemMounts =
    params.filesystemMounts ??
    createDefaultFilesystemMounts({ skillsEnabled: Boolean(params.skills?.length) });

  const agent = createDeepAgent({
    model,
    tools: params.tools ?? [],
    systemPrompt: buildRuntimeSystemPrompt(params.runtimePrompt, {
      mounts: filesystemMounts,
    }),
    middleware: [
      createKnowledgeFilesystemToolDescriptionMiddleware({
        mounts: filesystemMounts,
      }),
      ...contextCompressionMiddleware,
    ],
    checkpointer,
    backend: params.backend,
    skills: params.skills,
  });

  return agent;
}

/**
 * Build the config for agent invocation with checkpointer thread_id.
 * This maps the agent's conversation state to the thread record.
 */
export function buildAgentConfig(threadId: string, extra: Record<string, unknown> = {}) {
  return {
    configurable: {
      thread_id: threadId,
      ...extra,
    },
  };
}
