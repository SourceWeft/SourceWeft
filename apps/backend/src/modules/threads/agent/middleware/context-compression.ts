import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { LangChainModelExecutionConfig } from "@sourceweft/model-gateway";
import {
  ClearToolUsesEdit,
  contextEditingMiddleware,
  countTokensApproximately,
  createMiddleware,
  type AgentMiddleware,
  type ContextEdit,
  type TokenCounter,
} from "langchain";
import {
  endSpan,
  startSpan,
  type TraceContext,
} from "../../../llm-observability";
import { ContentError } from "../../../content/errors";
import { config } from "../../../../shared/config";
import {
  agentToolNamesByCapability,
  hasAgentToolCapability,
} from "@sourceweft/agent-tool-registry";

const DEFAULT_CONTEXT_LENGTH = config.chat.agent.defaultContextLength;
export const SOURCEWEFT_TOOL_OUTPUT_PLACEHOLDER =
  "[cleared - older tool output trimmed for context]";
const RECENT_TOOL_RESULTS_TO_KEEP = 5;
const RECENT_MESSAGES_TO_KEEP = 20;
const SUMMARY_MESSAGE_TRIGGER = 40;
const MAX_RESERVED_OUTPUT_TOKENS = config.chat.agent.maxReservedOutputTokens;
const OVERSIZED_CURRENT_TURN_TOOL_NAMES = new Set(
  agentToolNamesByCapability("oversized_current_turn").filter((name) =>
    hasAgentToolCapability(name, "oversized_current_turn"),
  ),
);

export const SOURCEWEFT_HISTORY_PATH_PREFIX = "/conversation_history";

export const SOURCEWEFT_PROTECTED_SYSTEM_BLOCKS = [
  "<system_instruction>",
  "<evidence_workflow>",
  "<citation_instructions>",
  "<output_rules>",
  "<runtime_context>",
  "<source_scope>",
  "<selected_skills>",
  "<user_memory>",
  "<team_memory>",
];

export const SOURCEWEFT_SUMMARY_SECTIONS = [
  "## Goal",
  "## Constraints",
  "## Progress",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
  "## Relevant Sources",
  "## Non-Evidence Reminder",
];

export const SOURCEWEFT_STRUCTURED_SUMMARY_PROMPT = `You are SourceWeft's conversation memory compressor.

Create a concise structured summary of the older conversation history. This summary is conversation memory only. It is not source evidence and cannot support source-grounded factual claims.

Rules:
- Preserve the user's goal, constraints, preferences, completed progress, key decisions, and next steps.
- Preserve source locator hints only, such as source titles, source ids, paths, query keywords, or tool names that may help future retrieval.
- Do not preserve long source excerpts, full tool outputs, chain-of-thought, private reasoning, or secret-like values.
- Do not summarize or rewrite protected system/policy/runtime blocks: ${SOURCEWEFT_PROTECTED_SYSTEM_BLOCKS.join(", ")}.
- Remove reusable citation markers. Rewrite markers such as [citation:c12] as plain text like "old citation marker c12 removed".
- Never imply that this summary can be used as evidence. Future source-grounded claims must retrieve current-turn evidence with citations again.

Return exactly these Markdown headings, in this order, with concise bullets where useful:
${SOURCEWEFT_SUMMARY_SECTIONS.join("\n")}

<messages>
{messages}
</messages>`;

export const SOURCEWEFT_SUMMARY_PREFIX =
  "SourceWeft compressed conversation memory. This is not source evidence and cannot support source-grounded factual claims:";

export type SourceWeftContextCompressionBudget = {
  contextLength: number;
  reservedOutputTokens: number;
  usableInputTokens: number;
  contextEditingTriggerTokens: number;
  contextEditingClearAtLeastTokens: number;
  summarizationTriggerTokens: number;
  recentToolResultsToKeep: number;
  recentMessagesToKeep: number;
  summaryMessageTrigger: number;
  historyPathPrefix: string;
};

export type SourceWeftContextCompressionReport = {
  enabled: boolean;
  contextEditingEnabled: boolean;
  toolPruned: boolean;
  summarized: boolean;
  summaryModelAlias: string | null;
  estimatedInputTokensBefore: number | null;
  estimatedInputTokensAfter: number | null;
  retainedMessageCount: number | null;
  triggerReason: string | null;
  prunedToolCount: number;
  contextLength: number;
  usableInputTokens: number;
  error?: string | null;
};

export type SourceWeftContextCompressionMiddlewareInput = {
  modelAlias: string;
  gatewayConfigId?: string | null;
  execution?: LangChainModelExecutionConfig;
  chatProfileConfig?: unknown;
  reportKey?: string;
  traceContext?: TraceContext;
};

type CompressionSettings = {
  enabled: boolean;
  contextEditingEnabled: boolean;
  traceEnabled: boolean;
  budget: SourceWeftContextCompressionBudget;
};

const compressionReports = new Map<
  string,
  SourceWeftContextCompressionReport
>();

function readFlag(name: string, defaultValue: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return !["0", "false", "no", "off", "disabled"].includes(raw);
}

function finitePositiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readContextLength(configJson: unknown) {
  const record = toObjectRecord(configJson);
  if (!record) {
    return DEFAULT_CONTEXT_LENGTH;
  }

  for (const key of [
    "contextLength",
    "context_length",
    "contextWindow",
    "context_window",
    "maxContextTokens",
  ]) {
    const value = finitePositiveInteger(record[key]);
    if (value) {
      return value;
    }
  }

  const nestedConfig = toObjectRecord(record.config);
  const nestedModel = toObjectRecord(record.model);
  return (
    finitePositiveInteger(nestedConfig?.contextLength) ??
    finitePositiveInteger(nestedModel?.contextLength) ??
    DEFAULT_CONTEXT_LENGTH
  );
}

export function resolveSourceWeftContextCompressionBudget(
  chatProfileConfig?: unknown,
): SourceWeftContextCompressionBudget {
  const contextLength = readContextLength(chatProfileConfig);
  const reservedOutputTokens = Math.min(
    MAX_RESERVED_OUTPUT_TOKENS,
    Math.floor(contextLength * 0.25),
  );
  const usableInputTokens = Math.max(1, contextLength - reservedOutputTokens);

  return {
    contextLength,
    reservedOutputTokens,
    usableInputTokens,
    contextEditingTriggerTokens: Math.max(
      1,
      Math.floor(usableInputTokens * 0.55),
    ),
    contextEditingClearAtLeastTokens: Math.max(
      1,
      Math.floor(usableInputTokens * 0.15),
    ),
    summarizationTriggerTokens: Math.max(
      1,
      Math.floor(usableInputTokens * 0.8),
    ),
    recentToolResultsToKeep: RECENT_TOOL_RESULTS_TO_KEEP,
    recentMessagesToKeep: RECENT_MESSAGES_TO_KEEP,
    summaryMessageTrigger: SUMMARY_MESSAGE_TRIGGER,
    historyPathPrefix: SOURCEWEFT_HISTORY_PATH_PREFIX,
  };
}

function resolveSettings(
  input: SourceWeftContextCompressionMiddlewareInput,
): CompressionSettings {
  return {
    enabled: readFlag("SOURCEWEFT_AGENT_COMPACTION_ENABLED", true),
    contextEditingEnabled: readFlag("SOURCEWEFT_CONTEXT_EDITING_ENABLED", true),
    traceEnabled: readFlag("SOURCEWEFT_CONTEXT_COMPRESSION_TRACE", true),
    budget: resolveSourceWeftContextCompressionBudget(input.chatProfileConfig),
  };
}

function uniqueReasons(...values: Array<string | null | undefined>) {
  const reasons = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const reason of value.split(",")) {
      const trimmed = reason.trim();
      if (trimmed) {
        reasons.add(trimmed);
      }
    }
  }
  return reasons.size > 0 ? Array.from(reasons).join(",") : null;
}

function mergeReport(
  previous: SourceWeftContextCompressionReport | undefined,
  next: Partial<SourceWeftContextCompressionReport>,
): SourceWeftContextCompressionReport {
  return {
    enabled: next.enabled ?? previous?.enabled ?? true,
    contextEditingEnabled:
      next.contextEditingEnabled ?? previous?.contextEditingEnabled ?? true,
    toolPruned: previous?.toolPruned === true || next.toolPruned === true,
    summarized: previous?.summarized === true || next.summarized === true,
    summaryModelAlias:
      next.summaryModelAlias ?? previous?.summaryModelAlias ?? null,
    estimatedInputTokensBefore:
      Math.max(
        previous?.estimatedInputTokensBefore ?? 0,
        next.estimatedInputTokensBefore ?? 0,
      ) || null,
    estimatedInputTokensAfter:
      next.estimatedInputTokensAfter ??
      previous?.estimatedInputTokensAfter ??
      null,
    retainedMessageCount:
      next.retainedMessageCount ?? previous?.retainedMessageCount ?? null,
    triggerReason: uniqueReasons(previous?.triggerReason, next.triggerReason),
    prunedToolCount: Math.max(
      previous?.prunedToolCount ?? 0,
      next.prunedToolCount ?? 0,
    ),
    contextLength:
      next.contextLength ?? previous?.contextLength ?? DEFAULT_CONTEXT_LENGTH,
    usableInputTokens:
      next.usableInputTokens ??
      previous?.usableInputTokens ??
      DEFAULT_CONTEXT_LENGTH,
    error: next.error ?? previous?.error ?? null,
  };
}

function recordCompressionReport(
  reportKey: string | undefined,
  report: Partial<SourceWeftContextCompressionReport>,
) {
  if (!reportKey) {
    return;
  }
  compressionReports.set(
    reportKey,
    mergeReport(compressionReports.get(reportKey), report),
  );
}

export function consumeSourceWeftContextCompressionReport(
  reportKey: string | undefined,
) {
  if (!reportKey) {
    return null;
  }
  const report = compressionReports.get(reportKey) ?? null;
  compressionReports.delete(reportKey);
  return report;
}

export function sanitizeSourceWeftSummaryText(text: string) {
  return text
    .replace(/\[citation:([^\]\s]+)\]/gi, "old citation marker $1 removed")
    .replace(/\bcitation:([a-z0-9_-]+)\b/gi, "old citation marker $1")
    .replace(/<citation\b[^>]*>.*?<\/citation>/gis, "old citation removed");
}

export function estimateSourceWeftMessageTokens(messages: BaseMessage[]) {
  return countTokensApproximately(messages);
}

function estimateSingleMessageTokens(message: BaseMessage) {
  return estimateSourceWeftMessageTokens([message]);
}

function latestHumanMessage(messages: BaseMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && HumanMessage.isInstance(message)) {
      return message;
    }
  }
  return null;
}

function latestHumanMessageIndex(messages: BaseMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && HumanMessage.isInstance(message)) {
      return index;
    }
  }
  return -1;
}

function latestHumanBoundary(messages: BaseMessage[]) {
  const index = latestHumanMessageIndex(messages);
  return index >= 0 ? index : messages.length;
}

function isToolResultFromTool(
  message: BaseMessage,
  toolNames: ReadonlySet<string>,
) {
  if (!ToolMessage.isInstance(message)) {
    return false;
  }
  return typeof message.name === "string" && toolNames.has(message.name);
}

function assertCurrentTurnToolResultsFit(
  messages: BaseMessage[],
  budget: SourceWeftContextCompressionBudget,
) {
  const currentTurnStart = latestHumanBoundary(messages);
  const currentTurnMessages = messages.slice(currentTurnStart + 1);
  for (const message of currentTurnMessages) {
    if (!isToolResultFromTool(message, OVERSIZED_CURRENT_TURN_TOOL_NAMES)) {
      continue;
    }
    const tokens = estimateSingleMessageTokens(message);
    if (tokens <= budget.usableInputTokens) {
      continue;
    }
    const toolName = ToolMessage.isInstance(message) ? message.name : null;
    if (toolName && hasAgentToolCapability(toolName, "read_tool_output")) {
      throw new ContentError(
        413,
        "SOURCE_CONTEXT_TOO_LARGE",
        "The current source read is larger than the available model input context. Narrow the source scope or use targeted search before retrying.",
      );
    }
    throw new ContentError(
      413,
      "TOOL_RESULT_TOO_LARGE",
      "The current tool result is larger than the available model input context. Narrow the request before retrying.",
    );
  }
}

export function assertSourceWeftCurrentUserMessageFits(
  messages: BaseMessage[],
  budget: SourceWeftContextCompressionBudget,
) {
  const message = latestHumanMessage(messages);
  if (!message) {
    return;
  }
  const tokens = estimateSingleMessageTokens(message);
  if (tokens <= budget.usableInputTokens) {
    return;
  }
  throw new ContentError(
    413,
    "MESSAGE_TOO_LARGE",
    "The current message is larger than the available model input context. Shorten the message or narrow the source range before retrying.",
  );
}

export function fallbackSourceWeftMessagesToRecentWindow(
  messages: BaseMessage[],
  budget: SourceWeftContextCompressionBudget,
) {
  const systemMessages: BaseMessage[] = [];
  const conversationMessages: BaseMessage[] = [];
  for (const message of messages) {
    if ((message as { _getType?: () => string })._getType?.() === "system") {
      systemMessages.push(message);
    } else {
      conversationMessages.push(message);
    }
  }

  const currentTurnStart = latestHumanMessageIndex(conversationMessages);
  const protectedSuffix =
    currentTurnStart >= 0
      ? conversationMessages.slice(currentTurnStart)
      : conversationMessages.slice(-budget.recentMessagesToKeep);
  const previousMessages =
    currentTurnStart >= 0
      ? conversationMessages.slice(0, currentTurnStart)
      : conversationMessages.slice(0, -budget.recentMessagesToKeep);
  const recentPrefix = previousMessages.slice(-budget.recentMessagesToKeep);
  const nextMessages = [...systemMessages, ...recentPrefix, ...protectedSuffix];
  messages.splice(0, messages.length, ...nextMessages);

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!ToolMessage.isInstance(message)) {
      continue;
    }
    const aiMessage = findMatchingAIMessage(messages.slice(0, index), message);
    if (!aiMessage) {
      continue;
    }
    if (
      aiMessage.tool_calls?.some(
        (toolCall) => toolCall.id === message.tool_call_id,
      )
    ) {
      continue;
    }
    messages.splice(index, 1);
    index -= 1;
  }
}

function findMatchingAIMessage(
  previousMessages: BaseMessage[],
  toolMessage: ToolMessage,
) {
  for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
    const message = previousMessages[index];
    if (
      AIMessage.isInstance(message) &&
      message.tool_calls?.some(
        (toolCall) => toolCall.id === toolMessage.tool_call_id,
      )
    ) {
      return message;
    }
  }
  return null;
}

function triggerReasons(input: {
  tokens: number;
  messages: number;
  budget: SourceWeftContextCompressionBudget;
}) {
  const reasons: string[] = [];
  if (input.tokens >= input.budget.contextEditingTriggerTokens) {
    reasons.push("context_edit_threshold");
  }
  if (input.tokens >= input.budget.summarizationTriggerTokens) {
    reasons.push("summarization_token_threshold");
  }
  if (input.messages >= input.budget.summaryMessageTrigger) {
    reasons.push("summarization_message_threshold");
  }
  return reasons.length > 0 ? reasons.join(",") : null;
}

function countClearedToolResults(messages: BaseMessage[]) {
  return messages.filter((message) => {
    if (!ToolMessage.isInstance(message)) {
      return false;
    }
    const metadata = toObjectRecord(message.response_metadata);
    const contextEditing = toObjectRecord(metadata?.context_editing);
    return contextEditing?.cleared === true;
  }).length;
}

class SourceWeftCurrentTurnAwareClearToolUsesEdit implements ContextEdit {
  private readonly edit: ClearToolUsesEdit;

  constructor(private readonly budget: SourceWeftContextCompressionBudget) {
    this.edit = new ClearToolUsesEdit({
      trigger: { tokens: 1 },
      keep: { messages: budget.recentToolResultsToKeep },
      clearToolInputs: false,
      placeholder: SOURCEWEFT_TOOL_OUTPUT_PLACEHOLDER,
    });
  }

  async apply(params: {
    messages: BaseMessage[];
    countTokens: TokenCounter;
    model?: BaseLanguageModel;
  }) {
    const tokens = await params.countTokens(params.messages);
    if (tokens < this.budget.contextEditingTriggerTokens) {
      return;
    }

    const currentTurnStart = latestHumanMessageIndex(params.messages);
    const editableEnd =
      currentTurnStart >= 0 ? currentTurnStart : params.messages.length;
    if (editableEnd <= 0) {
      return;
    }

    const editableMessages = params.messages.slice(0, editableEnd);
    await this.edit.apply({
      messages: editableMessages,
      countTokens: params.countTokens,
      model: params.model as BaseLanguageModel,
    });
    params.messages.splice(0, editableEnd, ...editableMessages);
  }
}

export function createSourceWeftToolOutputEdit(
  budget: SourceWeftContextCompressionBudget,
): ContextEdit {
  return new SourceWeftCurrentTurnAwareClearToolUsesEdit(budget);
}

function compressionScope(traceContext?: TraceContext) {
  return {
    teamId: traceContext?.teamId,
    workspaceId: traceContext?.workspaceId,
    threadId: traceContext?.threadId,
    userId: traceContext?.userId,
    messageId: traceContext?.messageId,
  };
}

async function recordCompressionSpan(input: {
  traceContext?: TraceContext;
  enabled: boolean;
  operation: "context.edit" | "context.summarize" | "context.overflow_retry";
  modelAlias: string | null;
  metadata: Record<string, unknown>;
  status?: "ok" | "error";
  error?: unknown;
}) {
  if (!input.enabled || !input.traceContext) {
    return;
  }

  const { traceContext } = input;
  const span = await startSpan({
    ...traceContext,
    name: input.operation,
    kind: "system",
    operation: input.operation,
    payloadMode: "metadata_only",
    metadata: {
      ...compressionScope(traceContext),
      modelAlias: input.modelAlias,
      ...input.metadata,
    },
  });

  await endSpan({
    traceId: traceContext.traceId,
    teamId: traceContext.teamId,
    workspaceId: traceContext.workspaceId,
    spanId: span.spanId,
    status: input.status ?? (input.error ? "error" : "ok"),
    payloadMode: "metadata_only",
    errorCode:
      input.error instanceof Error
        ? ((input.error as { code?: string }).code ?? input.error.name)
        : null,
    errorMessage: input.error instanceof Error ? input.error.message : null,
    metadata: input.metadata,
  });
}

function isContextOverflowError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const errorRecord = error as Error & { code?: unknown; status?: unknown };
  const code = typeof errorRecord.code === "string" ? errorRecord.code : "";
  const status =
    typeof errorRecord.status === "number" ? String(errorRecord.status) : "";
  const text = `${error.name} ${code} ${status} ${error.message}`.toLowerCase();
  return (
    text.includes("context_length_exceeded") ||
    text.includes("context window") ||
    text.includes("maximum context") ||
    text.includes("prompt is too long") ||
    text.includes("input is too long") ||
    text.includes("too many tokens")
  );
}

function errorSummary(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 240);
  }
  return String(error).slice(0, 240);
}

function createSourceWeftCompressionTraceMiddleware(input: {
  settings: CompressionSettings;
  reportKey?: string;
  traceContext?: TraceContext;
  modelAlias: string;
  summaryModelAlias: string | null;
}) {
  let beforeModelTokens: number | null = null;
  let beforeModelMessageCount: number | null = null;
  let overflowRetried = false;

  return createMiddleware({
    name: "SourceWeftContextCompressionTrace",
    beforeModel: async (state) => {
      const messages = Array.isArray(state.messages)
        ? (state.messages as BaseMessage[])
        : [];
      beforeModelTokens = estimateSourceWeftMessageTokens(messages);
      beforeModelMessageCount = messages.length;
      assertSourceWeftCurrentUserMessageFits(messages, input.settings.budget);
      assertCurrentTurnToolResultsFit(messages, input.settings.budget);

      recordCompressionReport(input.reportKey, {
        enabled: input.settings.enabled,
        contextEditingEnabled: input.settings.contextEditingEnabled,
        summaryModelAlias: input.summaryModelAlias,
        estimatedInputTokensBefore: beforeModelTokens,
        retainedMessageCount: messages.length,
        triggerReason: triggerReasons({
          tokens: beforeModelTokens,
          messages: messages.length,
          budget: input.settings.budget,
        }),
        contextLength: input.settings.budget.contextLength,
        usableInputTokens: input.settings.budget.usableInputTokens,
      });
    },
    wrapModelCall: async (request, handler) => {
      const beforeCallTokens = estimateSourceWeftMessageTokens(
        request.messages,
      );
      const beforeCallClearedTools = countClearedToolResults(request.messages);
      const beforeCallMessageCount = request.messages.length;

      const finalizeReport = async (extraReason?: string) => {
        const afterTokens = estimateSourceWeftMessageTokens(request.messages);
        const afterClearedTools = countClearedToolResults(request.messages);
        const prunedToolCount = Math.max(
          0,
          afterClearedTools - beforeCallClearedTools,
        );
        const toolPruned =
          prunedToolCount > 0 || afterTokens < beforeCallTokens;
        const summarized =
          (beforeModelTokens ?? beforeCallTokens) > beforeCallTokens ||
          (beforeModelMessageCount ?? beforeCallMessageCount) >
            beforeCallMessageCount;
        const reason = uniqueReasons(
          triggerReasons({
            tokens: beforeModelTokens ?? beforeCallTokens,
            messages: beforeModelMessageCount ?? beforeCallMessageCount,
            budget: input.settings.budget,
          }),
          extraReason,
        );

        recordCompressionReport(input.reportKey, {
          enabled: input.settings.enabled,
          contextEditingEnabled: input.settings.contextEditingEnabled,
          toolPruned,
          summarized,
          summaryModelAlias: input.summaryModelAlias,
          estimatedInputTokensBefore: beforeModelTokens ?? beforeCallTokens,
          estimatedInputTokensAfter: afterTokens,
          retainedMessageCount: request.messages.length,
          triggerReason: reason,
          prunedToolCount,
          contextLength: input.settings.budget.contextLength,
          usableInputTokens: input.settings.budget.usableInputTokens,
        });

        if (
          beforeCallTokens >= input.settings.budget.contextEditingTriggerTokens
        ) {
          await recordCompressionSpan({
            traceContext: input.traceContext,
            enabled: input.settings.traceEnabled,
            operation: "context.edit",
            modelAlias: input.modelAlias,
            metadata: {
              triggerThreshold:
                input.settings.budget.contextEditingTriggerTokens,
              beforeTokenEstimate: beforeCallTokens,
              afterTokenEstimate: afterTokens,
              prunedToolCount,
              summaryGenerated: summarized,
              triggerReason: reason,
            },
          });
        }

        const summaryTriggered =
          (beforeModelTokens ?? beforeCallTokens) >=
            input.settings.budget.summarizationTriggerTokens ||
          (beforeModelMessageCount ?? beforeCallMessageCount) >=
            input.settings.budget.summaryMessageTrigger;
        if (summaryTriggered) {
          await recordCompressionSpan({
            traceContext: input.traceContext,
            enabled: input.settings.traceEnabled,
            operation: "context.summarize",
            modelAlias: input.summaryModelAlias,
            metadata: {
              triggerThreshold:
                input.settings.budget.summarizationTriggerTokens,
              messageTrigger: input.settings.budget.summaryMessageTrigger,
              beforeTokenEstimate: beforeModelTokens ?? beforeCallTokens,
              afterTokenEstimate: beforeCallTokens,
              prunedToolCount,
              summaryGenerated: summarized,
              triggerReason: reason,
              historyPathPrefix: input.settings.budget.historyPathPrefix,
            },
          });
        }
      };

      try {
        const response = await handler(request);
        await finalizeReport();
        return response;
      } catch (error) {
        if (!overflowRetried && isContextOverflowError(error)) {
          overflowRetried = true;
          fallbackSourceWeftMessagesToRecentWindow(
            request.messages,
            input.settings.budget,
          );
          recordCompressionReport(input.reportKey, {
            enabled: input.settings.enabled,
            contextEditingEnabled: input.settings.contextEditingEnabled,
            summaryModelAlias: input.summaryModelAlias,
            triggerReason: "context_overflow",
            error: errorSummary(error),
            contextLength: input.settings.budget.contextLength,
            usableInputTokens: input.settings.budget.usableInputTokens,
          });
          await recordCompressionSpan({
            traceContext: input.traceContext,
            enabled: input.settings.traceEnabled,
            operation: "context.overflow_retry",
            modelAlias: input.modelAlias,
            metadata: {
              beforeTokenEstimate: beforeCallTokens,
              afterTokenEstimate: estimateSourceWeftMessageTokens(
                request.messages,
              ),
              triggerReason: "context_overflow",
              retryAttempt: 1,
            },
          });

          try {
            const response = await handler(request);
            await finalizeReport("context_overflow_retry");
            return response;
          } catch (retryError) {
            recordCompressionReport(input.reportKey, {
              enabled: input.settings.enabled,
              contextEditingEnabled: input.settings.contextEditingEnabled,
              summaryModelAlias: input.summaryModelAlias,
              triggerReason: "context_overflow_retry_failed",
              error: errorSummary(retryError),
              contextLength: input.settings.budget.contextLength,
              usableInputTokens: input.settings.budget.usableInputTokens,
            });
            await recordCompressionSpan({
              traceContext: input.traceContext,
              enabled: input.settings.traceEnabled,
              operation: "context.overflow_retry",
              modelAlias: input.modelAlias,
              status: "error",
              error: retryError,
              metadata: {
                beforeTokenEstimate: beforeCallTokens,
                triggerReason: "context_overflow_retry_failed",
                retryAttempt: 1,
              },
            });
            throw retryError;
          }
        }

        recordCompressionReport(input.reportKey, {
          enabled: input.settings.enabled,
          contextEditingEnabled: input.settings.contextEditingEnabled,
          summaryModelAlias: input.summaryModelAlias,
          triggerReason: "model_call_error",
          error: errorSummary(error),
          contextLength: input.settings.budget.contextLength,
          usableInputTokens: input.settings.budget.usableInputTokens,
        });
        throw error;
      }
    },
  });
}

function createSourceWeftPreSummaryContextEditingMiddleware(input: {
  settings: CompressionSettings;
  reportKey?: string;
  traceContext?: TraceContext;
  modelAlias: string;
}) {
  const edit = createSourceWeftToolOutputEdit(input.settings.budget);

  return createMiddleware({
    name: "SourceWeftPreSummaryContextEditing",
    beforeModel: async (state) => {
      const messages = Array.isArray(state.messages)
        ? (state.messages as BaseMessage[])
        : [];
      if (messages.length === 0) {
        return;
      }

      const beforeTokens = estimateSourceWeftMessageTokens(messages);
      const beforeClearedTools = countClearedToolResults(messages);
      if (beforeTokens < input.settings.budget.contextEditingTriggerTokens) {
        return;
      }

      await edit.apply({
        messages,
        countTokens: estimateSourceWeftMessageTokens,
        model: {} as BaseLanguageModel,
      });

      const afterTokens = estimateSourceWeftMessageTokens(messages);
      const prunedToolCount = Math.max(
        0,
        countClearedToolResults(messages) - beforeClearedTools,
      );
      recordCompressionReport(input.reportKey, {
        enabled: input.settings.enabled,
        contextEditingEnabled: input.settings.contextEditingEnabled,
        toolPruned: prunedToolCount > 0 || afterTokens < beforeTokens,
        estimatedInputTokensBefore: beforeTokens,
        estimatedInputTokensAfter: afterTokens,
        retainedMessageCount: messages.length,
        triggerReason: "context_edit_threshold",
        prunedToolCount,
        contextLength: input.settings.budget.contextLength,
        usableInputTokens: input.settings.budget.usableInputTokens,
      });

      await recordCompressionSpan({
        traceContext: input.traceContext,
        enabled: input.settings.traceEnabled,
        operation: "context.edit",
        modelAlias: input.modelAlias,
        metadata: {
          triggerThreshold: input.settings.budget.contextEditingTriggerTokens,
          clearAtLeastTokens:
            input.settings.budget.contextEditingClearAtLeastTokens,
          beforeTokenEstimate: beforeTokens,
          afterTokenEstimate: afterTokens,
          prunedToolCount,
          summaryGenerated: false,
          triggerReason: "context_edit_threshold",
        },
      });
    },
  });
}

export async function createSourceWeftContextCompressionMiddleware(
  input: SourceWeftContextCompressionMiddlewareInput,
): Promise<AgentMiddleware[]> {
  const settings = resolveSettings(input);
  if (!settings.enabled) {
    recordCompressionReport(input.reportKey, {
      enabled: false,
      contextEditingEnabled: false,
      toolPruned: false,
      summarized: false,
      summaryModelAlias: null,
      triggerReason: "disabled",
      contextLength: settings.budget.contextLength,
      usableInputTokens: settings.budget.usableInputTokens,
    });
    return [];
  }

  const middleware: AgentMiddleware[] = [];
  const summaryModelAlias = null;

  middleware.push(
    createSourceWeftCompressionTraceMiddleware({
      settings,
      reportKey: input.reportKey,
      traceContext: input.traceContext,
      modelAlias: input.modelAlias,
      summaryModelAlias,
    }),
  );

  if (settings.contextEditingEnabled) {
    middleware.push(
      createSourceWeftPreSummaryContextEditingMiddleware({
        settings,
        reportKey: input.reportKey,
        traceContext: input.traceContext,
        modelAlias: input.modelAlias,
      }),
    );
  }

  if (settings.contextEditingEnabled) {
    middleware.push(
      contextEditingMiddleware({
        edits: [createSourceWeftToolOutputEdit(settings.budget)],
        tokenCountMethod: "approx",
      }),
    );
  }

  return middleware;
}
