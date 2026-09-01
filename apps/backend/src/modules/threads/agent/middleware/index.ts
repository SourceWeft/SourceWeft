import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { AnyBackendProtocol } from "deepagents";
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
import { createRepeatToolCallReminderMiddleware } from "./repeat-tool-call-reminder";
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
import { createSourceWeftToolErrorMiddleware } from "./tool-error";
import { createSourceWeftToolExecutionTimeoutMiddleware } from "./tool-execution-timeout";
import type { TraceContext } from "../../../llm-observability";
import { createSourceWeftToolCallContextMiddleware } from "./tool-call-context";
import { createSourceWeftToolCallCountChannelsMiddleware } from "./tool-call-count-channels";

const RETRYABLE_READ_TOOL_NAMES = [
  AGENT_TOOL_NAMES.searchSources,
  AGENT_TOOL_NAMES.ls,
  AGENT_TOOL_NAMES.glob,
  AGENT_TOOL_NAMES.grep,
  AGENT_TOOL_NAMES.readFile,
];

// Per-turn ceiling on proactive questions so an over-eager model can't stall a
// turn re-prompting the user. exitBehavior "continue" blocks the excess call
// with an error ToolMessage (the model reads it and moves on) rather than
// aborting the turn. Complements the <asking_the_user> prompt policy and the
// generic repeat-tool-call reminder.
const ASK_USER_RUN_LIMIT = 3;

function askUserMiddleware(): AgentMiddleware[] {
  if (!config.chat.agent.askUserEnabled) {
    return [];
  }
  return [
    createAskUserMiddleware(),
    toolCallLimitMiddleware({
      toolName: AGENT_TOOL_NAMES.askUser,
      runLimit: ASK_USER_RUN_LIMIT,
      exitBehavior: "continue",
    }),
  ];
}

export type SourceWeftAgentMiddlewareStackInput = {
  backend: AnyBackendProtocol;
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
  backend: AnyBackendProtocol;
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
    // Must precede every toolCallLimitMiddleware so the count channels bind to a
    // concurrent-safe reducer (parallel `task` subagents write them at once).
    createSourceWeftToolCallCountChannelsMiddleware(),
    createSourceWeftToolCallContextMiddleware({
      subagentType: input.toolObservabilityContext?.subagentType,
    }),
    // Sub-agents may also ask the user. The interrupt bubbles up to the parent
    // graph's updates stream; the resume is keyed by interrupt id so it targets
    // the correct nested/parallel task. Same flag + per-turn cap as the root.
    ...askUserMiddleware(),
    createRepeatToolCallReminderMiddleware(),
    createSourceWeftToolErrorMiddleware(),
    createSourceWeftToolObservabilityMiddleware({
      context: input.toolObservabilityContext,
      traceContext: input.traceContext,
    }),
    createSourceWeftToolExecutionTimeoutMiddleware(),
    toolRetryMiddleware({
      tools: RETRYABLE_READ_TOOL_NAMES,
      onFailure: "error",
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
    // Must precede every toolCallLimitMiddleware so the count channels bind to a
    // concurrent-safe reducer (parallel `task` subagents write them at once).
    createSourceWeftToolCallCountChannelsMiddleware(),
    createSourceWeftToolCallContextMiddleware(),
    // deepagents >=1.12 no longer includes the todo middleware by default;
    // tool tracking and the todo panel depend on the write_todos tool.
    todoListMiddleware(),
    // Proactive `askUser` (+ a per-turn call cap). Enabled by default; see
    // config.chat.agent.askUserEnabled. Also added to the sub-agent stack.
    ...askUserMiddleware(),
    // Generic advisory loop guard for all tools (nudges out of identical-call
    // loops; complements the askUser cap). Never blocks a call.
    createRepeatToolCallReminderMiddleware(),
    createSourceWeftImageHistorySanitizerMiddleware(),
    createKnowledgeFilesystemToolDescriptionMiddleware({
      mounts: input.filesystemMounts,
    }),
    ...(input.commandExecutionPolicy
      ? [createCommandToolChoiceMiddleware(input.commandExecutionPolicy)]
      : []),
    createSourceWeftToolErrorMiddleware(),
    createSourceWeftToolObservabilityMiddleware({
      context: input.toolObservabilityContext,
      traceContext: input.traceContext,
    }),
    createSourceWeftToolExecutionTimeoutMiddleware(),
    toolRetryMiddleware({
      tools: RETRYABLE_READ_TOOL_NAMES,
      onFailure: "error",
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
  createSourceWeftToolErrorMiddleware,
  formatSourceWeftToolError,
} from "./tool-error";
export {
  createSourceWeftToolObservabilityMiddleware,
  type SourceWeftToolObservabilityContext,
} from "./tool-observability";
export {
  createSourceWeftToolCallContextMiddleware,
  currentSourceWeftToolCallContext,
  currentSourceWeftToolCallId,
  currentSourceWeftToolInvocationSignal,
  runWithSourceWeftToolInvocationSignal,
} from "./tool-call-context";
export {
  AGENT_TOOL_EXECUTION_TIMEOUT_CODE,
  AGENT_TOOL_HOST_EXECUTION_TIMEOUT_MAX_MS,
  AGENT_TOOL_TERMINATION_GRACE_MS,
  AGENT_TOOL_TERMINATION_UNKNOWN_CODE,
  AgentToolExecutionTimeoutError,
  AgentToolTerminationUnknownError,
  createSourceWeftToolExecutionTimeoutMiddleware,
  findAgentToolTerminationUnknownReason,
  isAgentToolExecutionTimeoutReason,
  isAgentToolTerminationUnknownReason,
  type AgentToolExecutionTimeoutReason,
  type AgentToolTerminationUnknownReason,
  type SourceWeftToolExecutionTimeoutMiddlewareInput,
} from "./tool-execution-timeout";
