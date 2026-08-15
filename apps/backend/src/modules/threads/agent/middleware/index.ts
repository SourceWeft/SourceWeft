import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { AnyBackendProtocol, BackendFactory } from "deepagents";
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
import { createAskUserMiddleware } from "./ask-user";
import {
  createCommandToolChoiceMiddleware,
  type CommandExecutionPolicy,
} from "./command-tool-choice";
import {
  createSourceWeftContextCompressionMiddleware,
  createSourceWeftSummarizationMiddleware,
} from "./context-compression";
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
  backend: AnyBackendProtocol | BackendFactory;
  chatProfileConfig?: unknown;
  commandExecutionPolicy?: CommandExecutionPolicy;
  contextCompressionReportKey?: string;
  execution?: LangChainModelExecutionConfig;
  extraMiddleware?: AgentMiddleware[];
  filesystemMounts: AgentFilesystemMountCapability[];
  gatewayConfigId?: string | null;
  modelAlias: string;
  model: BaseLanguageModel;
  toolObservabilityContext?: SourceWeftToolObservabilityContext;
  traceContext?: TraceContext;
};

export type SourceWeftSubagentMiddlewareStackInput = {
  backend: AnyBackendProtocol | BackendFactory;
  chatProfileConfig?: unknown;
  model: BaseLanguageModel;
  toolObservabilityContext?: SourceWeftToolObservabilityContext;
  traceContext?: TraceContext;
};

/**
 * Fresh middleware instances for each child graph. Deep Agents only propagates
 * same-name replacements into its built-in general-purpose child, and custom
 * children do not inherit parent middleware, so child governance is explicit.
 */
export function createSourceWeftSubagentMiddlewareStack(
  input: SourceWeftSubagentMiddlewareStackInput,
): AgentMiddleware[] {
  return [
    // Sub-agents may also ask the user. The interrupt bubbles up to the parent
    // graph's updates stream; the resume is keyed by interrupt id so it targets
    // the correct nested/parallel task. Same flag as the root stack.
    ...(config.chat.agent.askUserEnabled ? [createAskUserMiddleware()] : []),
    createSourceWeftToolObservabilityMiddleware({
      context: input.toolObservabilityContext,
      traceContext: input.traceContext,
    }),
    toolRetryMiddleware({
      tools: RETRYABLE_READ_TOOL_NAMES,
    }),
    createSourceWeftSummarizationMiddleware({
      backend: input.backend,
      chatProfileConfig: input.chatProfileConfig,
      model: input.model,
    }),
    modelRetryMiddleware({
      retryOn: isRetryableModelContentError,
      onFailure: "error",
    }),
    toolCallLimitMiddleware({
      runLimit: config.chat.agent.toolCallRunLimit,
      threadLimit: config.chat.agent.toolCallThreadLimit,
      exitBehavior: "continue",
    }),
  ];
}

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
    // Proactive `askUser` — root graph only (a delegated sub-agent has no human
    // answerer). Gated off by default until the frontend question panel ships.
    ...(config.chat.agent.askUserEnabled ? [createAskUserMiddleware()] : []),
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
    // Deep Agents merges same-named middleware by replacement. This takes the
    // place of its generic SummarizationMiddleware while retaining native
    // checkpoint/history offloading semantics.
    createSourceWeftSummarizationMiddleware({
      backend: input.backend,
      chatProfileConfig: input.chatProfileConfig,
      model: input.model,
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
export {
  createSourceWeftContextCompressionMiddleware,
  createSourceWeftSummarizationMiddleware,
} from "./context-compression";
export { createKnowledgeFilesystemToolDescriptionMiddleware } from "./filesystem-descriptions";
export {
  createSourceWeftImageHistorySanitizerMiddleware,
  sanitizeMessagesForHistory,
} from "./history-sanitizer";
export {
  createSourceWeftToolObservabilityMiddleware,
  type SourceWeftToolObservabilityContext,
} from "./tool-observability";
