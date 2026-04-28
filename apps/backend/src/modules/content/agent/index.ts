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
import type { AnyBackendProtocol } from "deepagents";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import type { LangChainModelExecutionConfig } from "@sourceweft/model-gateway";
import { CHAT_SYSTEM_PROMPT } from "./prompts";
import { getChatCheckpointer } from "../../../shared/chat-checkpointer";
import { createAgentChatModel } from "../../../shared/model-gateway/index";

const KB_LS_TOOL_DESCRIPTION = `Lists files in a directory. In SourceWeft, /kb is the read-only workspace knowledge view. When the user has selected or referenced sources for the current turn, /kb is scoped to those selected/current sources, so ls('/kb') lists the selected/current source files. Use this for questions about selected file names/paths, source identity, file enumeration, and source-wide coverage tasks that need to inspect selected sources. Do not call ls before retrieve or grep just to discover selected sources; those tools are already scoped to the selected/current sources.`;

const KB_READ_FILE_TOOL_DESCRIPTION = `Reads a file from the filesystem. In SourceWeft, files under /kb are indexed workspace sources, scoped to the selected/current sources when the user has selected or referenced sources for the current turn. Use read_file('/kb/...') when completeness across source content matters, including source-wide summarizing, reviewing, comparison, extracting all key points, listing document contents, analyzing full documents, preparing source material, or gathering surrounding context. Use pagination with offset and limit for long files.`;

const KB_GLOB_TOOL_DESCRIPTION = `Finds files matching a glob pattern. In SourceWeft, /kb is scoped to selected/current sources when sources are selected for the turn. Use glob under /kb to narrow selected/current source paths by filename or path pattern when the task depends on file identity or a file subset. Do not call glob before retrieve or grep just to discover selected sources.`;

const KB_GREP_TOOL_DESCRIPTION = `Searches /kb candidate chunks with a case-insensitive regular expression and returns matching lines. In SourceWeft, /kb is scoped to selected/current sources when sources are selected for the turn, so grep('/kb') does not need a prior ls. Use grep when the user's goal is lexical or regex location: finding where terms appear, checking whether a pattern exists, or locating identifiers, field labels, codes, URLs, names, invoice/order numbers, quoted terms, and simple OR patterns like "invoice|order|receipt". For targeted source-grounded Q&A that can be answered from relevant passages, use retrieve first; grep is a fallback or lexical-location tool, not a required preflight step. Escape regex metacharacters when literal matching is needed. Broad regex patterns without literal terms require a small selected/current source set or a narrowed source/chunk path.`;

function createKnowledgeFilesystemToolDescriptionMiddleware() {
  const setToolDescription = (tool: { description?: string }, description: string) => {
    tool.description = description;
    return tool;
  };

  return createMiddleware({
    name: "SourceWeftKnowledgeFilesystemDescriptions",
    wrapModelCall: async (request, handler) => {
      const tools = request.tools.map((tool) => {
        if (tool.name === "ls") {
          return setToolDescription(tool, KB_LS_TOOL_DESCRIPTION);
        }
        if (tool.name === "read_file") {
          return setToolDescription(tool, KB_READ_FILE_TOOL_DESCRIPTION);
        }
        if (tool.name === "glob") {
          return setToolDescription(tool, KB_GLOB_TOOL_DESCRIPTION);
        }
        if (tool.name === "grep") {
          return setToolDescription(tool, KB_GREP_TOOL_DESCRIPTION);
        }
        return tool;
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
    middleware: [createKnowledgeFilesystemToolDescriptionMiddleware()],
    checkpointer,
    backend: params.backend,
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
