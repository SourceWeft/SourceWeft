/**
 * Thread Agent using DeepAgent with LangGraph Checkpointer.
 *
 * This module provides the factory function for creating thread agents
 * with conversation history managed by LangGraph's PostgresSaver checkpointer.
 *
 * Note: Retrieval is done as pre-injection before agent call (hybrid RAG approach).
 * The agent tool for proactive search can be added later.
 */

import { createDeepAgent } from "deepagents";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { LangChainModelExecutionConfig } from "@sourceweft/model-gateway";
import { CHAT_SYSTEM_PROMPT } from "./agent/prompts";
import { getChatCheckpointer } from "../../shared/chat-checkpointer";
import { createAgentChatModel } from "../../shared/model-gateway";

export interface CreateThreadAgentParams {
  /** The model alias to use (e.g., "chat-default") */
  modelAlias?: string;
  gatewayConfigId?: string | null;
  execution?: LangChainModelExecutionConfig;
  tools?: Array<ClientTool | ServerTool>;
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

  const agent = createDeepAgent({
    model,
    tools: params.tools ?? [],
    systemPrompt: CHAT_SYSTEM_PROMPT,
    checkpointer,
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
