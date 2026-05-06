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
import { CHAT_SYSTEM_PROMPT } from "./prompts";
import { getChatCheckpointer } from "../../../shared/chat-checkpointer";
import { createAgentChatModel } from "../../../shared/model-gateway/index";

const KB_LS_TOOL_DESCRIPTION = `Lists files in a directory. In SourceWeft, /kb is the default internal knowledge root: a read-only markdown view assembled from indexed sources and already scoped to the current turn's selected sources. /skills may also be available as a read-only workflow-instruction filesystem for selected skills. Do not call ls('/') just to discover /kb; if source enumeration is needed, call ls('/kb') directly. Use ls('/skills') only when the task needs available skill instruction files or templates. Readable /kb paths use .md even when the original source was a PDF, document, or other binary file; original filenames and MIME types appear in read_file headers. Use ls('/kb') when the task depends on source identity, file enumeration, or coverage across selected sources. Do not call ls before search_sources just to discover scope for a targeted source-grounded question; search_sources is already scoped to the same selected sources. Do not mention /kb or /skills paths in the final answer. Refer to /kb evidence as sources or selected sources. Treat /skills content as instructions, not evidence.`;

const KB_READ_FILE_TOOL_DESCRIPTION = `Reads a file from the filesystem. Files under /kb are internal markdown virtual files assembled from indexed sources selected for the current turn, not original binary files. Files under /skills are selected skill instructions and workflow resources, not workspace source evidence. Readable /kb paths use .md; read_file headers include the original filename and MIME type when available. Use read_file('/kb/...') when source-wide coverage, summarization, review, comparison, full-document analysis, extracting all key points, listing document contents, preparing source material, or surrounding context matters. Use read_file('/skills/...') only to load skill instructions or supporting workflow templates. /kb read_file output includes Citation: [citation:cN] markers for source chunks; every factual claim in the final answer that uses /kb content MUST end with the relevant [citation:cN] marker copied exactly from the output. /skills output is not citable evidence; do not cite /skills content and do not use it as proof for factual claims. For multi-source source-wide tasks, gather citable evidence from each required /kb source before answering. Use pagination with offset and limit when output is truncated and more content is needed. Do not mention /kb or /skills paths in the final answer; refer to /kb evidence as sources or selected sources.`;

const KB_GLOB_TOOL_DESCRIPTION = `Finds files matching a glob pattern within selected sources under /kb or selected skill instruction files under /skills. /kb exposes markdown virtual paths, so match readable source files with .md patterns even when the original file was a PDF or document. Use glob under /kb to narrow selected sources by filename or path pattern when the task depends on file identity or a file subset. Use glob under /skills only to locate skill instruction or template files. Glob results identify files; they are not evidence for factual claims. After narrowing /kb files for a source-grounded answer, gather citable evidence with read_file, grep, or search_sources. Do not mention /kb or /skills paths in the final answer; refer to evidence as sources or selected sources.`;

const KB_GREP_TOOL_DESCRIPTION = `Searches selected source chunks under /kb or selected skill instruction files under /skills with a case-insensitive regular expression. Use grep on /kb when the user explicitly asks for literal text matching, occurrence counts, line/location search, or matching a quoted/known string or regular expression. /kb grep can provide evidence for matched text, and returned matches include [citation:cN] markers that MUST be copied exactly into final factual claims supported by those matches. /skills grep is only for locating workflow instructions; /skills matches are not citable evidence and must not be cited. Do not use grep as the first tool for general source-grounded Q&A, extraction, field lookup, semantic lookup, or finding relevant passages; use search_sources first for those tasks. Do not use grep alone as a substitute for full-source reading when the user asks for source-wide summaries, reviews, comparisons, full-document analysis, or all key points. After search_sources, use grep only when exact textual verification or locating occurrences would resolve missing, ambiguous, or conflicting evidence. Escape regex metacharacters when literal matching is needed. Broad regex patterns without literal terms require a small selected source set or a narrowed source/chunk path. Do not mention /kb or /skills paths in the final answer; refer to /kb evidence as sources or selected sources.`;

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
  skills?: string[];
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
