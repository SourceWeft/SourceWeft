import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  modelRetryMiddleware,
  todoListMiddleware,
  toolCallLimitMiddleware,
  toolRetryMiddleware,
  type AgentMiddleware,
} from "langchain";
import type { LangChainModelExecutionConfig } from "@sourceweft/model-gateway";
import type { AgentFilesystemMountCapability } from "../filesystem-capabilities";
import { isRetryableModelContentError } from "../../../content/model-gateway-error";
import { config } from "../../../../shared/config";
import {
  createCommandToolChoiceMiddleware,
  type CommandExecutionPolicy,
} from "./command-tool-choice";
import { createSourceWeftContextCompressionMiddleware } from "./context-compression";
import { createKnowledgeFilesystemToolDescriptionMiddleware } from "./filesystem-descriptions";
import { createSourceWeftImageHistorySanitizerMiddleware } from "./history-sanitizer";
import {
  createSourceWeftToolObservabilityMiddleware,
  type SourceWeftToolObservabilityContext,
} from "./tool-observability";
import type { TraceContext } from "../../../llm-observability";

const RETRYABLE_READ_TOOL_NAMES = [
  AGENT_TOOL_NAMES.searchSources,
  AGENT_TOOL_NAMES.ls,
  AGENT_TOOL_NAMES.glob,
  AGENT_TOOL_NAMES.grep,
  AGENT_TOOL_NAMES.readFile,
];

export type SourceWeftAgentMiddlewareStackInput = {
  chatProfileConfig?: unknown;
  commandExecutionPolicy?: CommandExecutionPolicy;
  contextCompressionReportKey?: string;
  execution?: LangChainModelExecutionConfig;
  extraMiddleware?: AgentMiddleware[];
  filesystemMounts: AgentFilesystemMountCapability[];
  gatewayConfigId?: string | null;
  modelAlias: string;
  toolObservabilityContext?: SourceWeftToolObservabilityContext;
  traceContext?: TraceContext;
};

export async function createSourceWeftAgentMiddlewareStack(
  input: SourceWeftAgentMiddlewareStackInput,
): Promise<AgentMiddleware[]> {
  const contextCompressionMiddleware =
    await createSourceWeftContextCompressionMiddleware({
      modelAlias: input.modelAlias,
      gatewayConfigId: input.gatewayConfigId,
      execution: input.execution,
      chatProfileConfig: input.chatProfileConfig,
      reportKey: input.contextCompressionReportKey,
      traceContext: input.traceContext,
    });

  return [
    // deepagents >=1.12 no longer includes the todo middleware by default;
    // tool tracking and the todo panel depend on the write_todos tool.
    todoListMiddleware(),
    createSourceWeftImageHistorySanitizerMiddleware(),
    createKnowledgeFilesystemToolDescriptionMiddleware({
      mounts: input.filesystemMounts,
    }),
    ...(input.commandExecutionPolicy
      ? [createCommandToolChoiceMiddleware(input.commandExecutionPolicy)]
      : []),
    createSourceWeftToolObservabilityMiddleware({
      context: input.toolObservabilityContext,
      traceContext: input.traceContext,
    }),
    toolRetryMiddleware({
      tools: RETRYABLE_READ_TOOL_NAMES,
    }),
    ...contextCompressionMiddleware,
    modelRetryMiddleware({
      retryOn: isRetryableModelContentError,
      onFailure: "error",
    }),
    toolCallLimitMiddleware({
      runLimit: config.chat.agent.toolCallRunLimit,
      threadLimit: config.chat.agent.toolCallThreadLimit,
      exitBehavior: "continue",
    }),
    ...(input.extraMiddleware ?? []),
  ];
}

export {
  createCommandToolChoiceMiddleware,
  forcedToolChoice,
  hasToolCallNamed,
  messageToolCalls,
  type CommandExecutionPolicy,
} from "./command-tool-choice";
export { createSourceWeftContextCompressionMiddleware } from "./context-compression";
export { createKnowledgeFilesystemToolDescriptionMiddleware } from "./filesystem-descriptions";
export {
  createSourceWeftImageHistorySanitizerMiddleware,
  sanitizeMessagesForHistory,
} from "./history-sanitizer";
export {
  createSourceWeftToolObservabilityMiddleware,
  type SourceWeftToolObservabilityContext,
} from "./tool-observability";
