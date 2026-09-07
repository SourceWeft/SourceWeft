/**
 * Observability for thread stream runs: the trace/span client object the
 * tests spy on, plus the builders that shape trace/span inputs, outputs and
 * metadata, and the idempotent trace/span terminators.
 *
 * Carved out of `service.ts` verbatim (T2.3 mechanical split); behavior and
 * the object identity of `threadStreamObservability` are unchanged —
 * `service.ts` re-exports it, so existing spies keep working.
 */
import { randomUUID } from "node:crypto";
import { ContentError } from "../../content/errors";
import { requireContentWorkspace } from "../../workspace/guards";
import {
  sanitizeClientErrorMessage,
  toContentError,
} from "../../content/model-gateway-error";
import { logger } from "../../../shared/logger";
import {
  buildGatewayAuditMetadata,
  resolveGatewayObservedIdentity,
} from "../../content/model-gateway-audit";
import {
  endSpan,
  endTrace,
  startSpan,
  startTrace,
  type TraceContext,
} from "../../llm-observability";
import type {
  ContentThreadTurnService,
  StreamThreadEventInput,
} from "../turn/service";
import type { DeepAgentTurnOutcome } from "../agent/turn/runner";
import type { AgentCitation } from "../agent/citation-registry";
import {
  AGENT_TOOL_TERMINATION_UNKNOWN_CODE,
  findAgentToolTerminationUnknownReason,
} from "../agent/middleware/tool-execution-timeout";
import {
  isSandboxExecuteToolCallIdRequiredError,
  sandboxExecuteToolCallIdRequiredContentError,
} from "../turn/sandbox-execute-error";

const OBSERVE_CITATION_EXCERPT_CHARS = 320;
const OBSERVE_CITATION_QUOTE_CHARS = 400;

export const threadStreamObservability = {
  startTrace,
  endTrace,
  startSpan,
  endSpan,
};

export function buildThreadTraceContext(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
): TraceContext {
  return {
    traceId: prepared.runTraceId,
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    userId: prepared.userId,
    threadId: prepared.thread.id,
    messageId: prepared.userMessage.id,
    sessionId: prepared.thread.id,
    feature: "chat",
  };
}

function buildTraceMetadata(input: {
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
  operation: "chat.stream" | "chat.complete";
}) {
  const observedIdentity = resolveGatewayObservedIdentity({
    llm: input.prepared.llm,
    modelAlias: input.prepared.modelAlias,
    profileAlias: input.prepared.profileAlias,
  });

  return {
    operation: input.operation,
    modelAlias: observedIdentity.modelAlias,
    profileAlias: observedIdentity.profileAlias,
    ...(observedIdentity.catalogModelAlias
      ? { catalogModelAlias: observedIdentity.catalogModelAlias }
      : {}),
    ...(observedIdentity.catalogProfileAlias
      ? { catalogProfileAlias: observedIdentity.catalogProfileAlias }
      : {}),
    agentMode: input.prepared.agentMode,
    sourceCount: input.prepared.selectedSourceIds.length,
    effectiveSourceCount: input.prepared.sourceIds.length,
    mentionedSourceCount: input.prepared.mentionedSourceIds.length,
    effectiveMentionedSourceCount:
      input.prepared.effectiveMentionedSourceIds.length,
    selectedSkillCount: 0,
    preflightThinkingStepCount: input.prepared.preflightThinkingSteps.length,
  };
}

export function toObservationError(error: unknown) {
  if (error instanceof ContentError) {
    return error;
  }
  const modelError = toContentError(error);
  if (modelError.code === "MODEL_CONFIGURATION_ERROR") return modelError;
  const terminationUnknown = findAgentToolTerminationUnknownReason(error);
  if (terminationUnknown) {
    return new ContentError(
      500,
      AGENT_TOOL_TERMINATION_UNKNOWN_CODE,
      "Tool execution stopped responding before remote termination could be confirmed.",
    );
  }
  if (isSandboxExecuteToolCallIdRequiredError(error)) {
    return sandboxExecuteToolCallIdRequiredContentError();
  }
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const cause = record.cause;
  const causeRecord =
    cause && typeof cause === "object"
      ? (cause as Record<string, unknown>)
      : {};
  const message =
    typeof record.message === "string" && record.message.trim().length > 0
      ? record.message
      : String(error);
  const causeMessage =
    typeof causeRecord.message === "string" &&
    causeRecord.message.trim().length > 0
      ? causeRecord.message
      : "";
  const combined = `${String(record.name ?? "")}\n${message}\n${causeMessage}`;
  if (
    combined.includes("MiddlewareError") ||
    combined.includes("SANDBOX_") ||
    combined.includes("Error invoking tool")
  ) {
    const displayMessage =
      message === "MiddlewareError" && causeMessage ? causeMessage : message;
    return new ContentError(
      500,
      "CHAT_RUN_FAILED",
      sanitizeClientErrorMessage(displayMessage),
    );
  }
  return modelError;
}

export function buildAgentRunSpanMetadata(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  const observedIdentity = resolveGatewayObservedIdentity({
    llm: prepared.llm,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
  });

  return {
    mode: prepared.agentMode,
    modelAlias: observedIdentity.modelAlias,
    profileAlias: observedIdentity.profileAlias,
    ...(observedIdentity.catalogModelAlias
      ? { catalogModelAlias: observedIdentity.catalogModelAlias }
      : {}),
    ...(observedIdentity.catalogProfileAlias
      ? { catalogProfileAlias: observedIdentity.catalogProfileAlias }
      : {}),
    gateway: buildGatewayAuditMetadata({ llm: prepared.llm }),
    selectedSkillCount: 0,
  };
}

function buildTraceInput(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  const observedIdentity = resolveGatewayObservedIdentity({
    llm: prepared.llm,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
  });

  return {
    message: prepared.messageContent,
    modelAlias: observedIdentity.modelAlias,
    profileAlias: observedIdentity.profileAlias,
    ...(observedIdentity.catalogModelAlias
      ? { catalogModelAlias: observedIdentity.catalogModelAlias }
      : {}),
    ...(observedIdentity.catalogProfileAlias
      ? { catalogProfileAlias: observedIdentity.catalogProfileAlias }
      : {}),
    sourceIds: prepared.selectedSourceIds,
    effectiveSourceIds: prepared.sourceIds,
    mentionedSourceIds: prepared.mentionedSourceIds,
    effectiveMentionedSourceIds: prepared.effectiveMentionedSourceIds,
    skillIds: [],
    threadId: prepared.thread.id,
    userMessageId: prepared.userMessage.id,
  };
}

function compactObservationText(value: string, maxChars: number) {
  return {
    preview: value.slice(0, maxChars),
    length: value.length,
    truncated: value.length > maxChars,
  };
}

function buildCitationObservation(citation: AgentCitation, index: number) {
  return {
    citation: citation.citation,
    rank: index + 1,
    sourceId: citation.sourceId,
    sourceTitle: citation.sourceTitle,
    documentId: citation.documentId,
    chunkId: citation.chunkId,
    chunkNo: citation.chunkNo,
    origin: citation.origin,
    score: citation.score,
    ...(citation.path ? { path: citation.path } : {}),
    excerpt: compactObservationText(
      citation.excerpt,
      OBSERVE_CITATION_EXCERPT_CHARS,
    ),
    quoteText: compactObservationText(
      citation.quoteText,
      OBSERVE_CITATION_QUOTE_CHARS,
    ),
  };
}

function buildCitationObservations(citations: AgentCitation[]) {
  return citations.map((citation, index) =>
    buildCitationObservation(citation, index),
  );
}

function buildReasoningSegmentObservations(
  segments: DeepAgentTurnOutcome["reasoningSegments"],
) {
  return segments.map((segment, index) => ({
    id: segment.id,
    index,
    sequence: segment.sequence,
    phase: segment.phase ?? "initial",
    ...(segment.toolCallId ? { toolCallId: segment.toolCallId } : {}),
    ...(segment.tool ? { tool: segment.tool } : {}),
    ...(typeof segment.durationMs === "number"
      ? { durationMs: segment.durationMs }
      : {}),
    text: compactObservationText(segment.text, OBSERVE_CITATION_QUOTE_CHARS),
  }));
}

function buildTraceOutput(outcome: DeepAgentTurnOutcome) {
  return {
    content: outcome.assistantContent,
    finishReason: outcome.finishReason,
    usage: outcome.usage,
    reasoning: outcome.reasoning,
    reasoningSegments: buildReasoningSegmentObservations(
      outcome.reasoningSegments,
    ),
    toolCalls: outcome.toolCalls,
    retrievalCalls: outcome.retrievalCalls,
    renderBlockCount: outcome.renderBlocks?.length ?? 0,
    meteredLlmCallCount: outcome.meteredLlmCalls?.length ?? 0,
    citationCount: outcome.citations.length,
    availableCitationCount: outcome.availableCitations.length,
    citations: buildCitationObservations(outcome.citations),
    availableCitations: buildCitationObservations(outcome.availableCitations),
  };
}

export function buildAgentRunSpanOutput(outcome: DeepAgentTurnOutcome) {
  return {
    assistantContent: outcome.assistantContent,
    finishReason: outcome.finishReason,
    usage: outcome.usage,
    reasoning: outcome.reasoning,
    reasoningSegments: buildReasoningSegmentObservations(
      outcome.reasoningSegments,
    ),
    toolCallCount: outcome.toolCalls.length,
    retrievalCallCount: outcome.retrievalCalls.length,
    citationCount: outcome.citations.length,
    availableCitationCount: outcome.availableCitations.length,
    citations: buildCitationObservations(outcome.citations),
    availableCitations: buildCitationObservations(outcome.availableCitations),
    thinkingStepCount: outcome.thinkingSteps.length,
    renderBlockCount: outcome.renderBlocks?.length ?? 0,
    reasoningSegmentCount: outcome.reasoningSegments.length,
  };
}

export function buildPrepareSpanInput(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return {
    message: prepared.messageContent,
    threadId: prepared.thread.id,
    userMessageId: prepared.userMessage.id,
    sourceIds: prepared.selectedSourceIds,
    effectiveSourceIds: prepared.sourceIds,
    mentionedSourceIds: prepared.mentionedSourceIds,
    effectiveMentionedSourceIds: prepared.effectiveMentionedSourceIds,
    skillIds: [],
  };
}

export function buildPrepareSpanOutput(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  const preflightCreditsConsumed = prepared.preflightBilling.reduce(
    (sum, item) => sum + item.consumedCredits,
    0,
  );

  const observedIdentity = resolveGatewayObservedIdentity({
    llm: prepared.llm,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
  });

  return {
    createdUserMessage: prepared.createdUserMessage,
    agentMode: prepared.agentMode,
    modelAlias: observedIdentity.modelAlias,
    profileAlias: observedIdentity.profileAlias,
    ...(observedIdentity.catalogModelAlias
      ? { catalogModelAlias: observedIdentity.catalogModelAlias }
      : {}),
    ...(observedIdentity.catalogProfileAlias
      ? { catalogProfileAlias: observedIdentity.catalogProfileAlias }
      : {}),
    sourceCount: prepared.selectedSourceIds.length,
    effectiveSourceCount: prepared.sourceIds.length,
    mentionedSourceCount: prepared.mentionedSourceIds.length,
    effectiveMentionedSourceCount: prepared.effectiveMentionedSourceIds.length,
    selectedSkillCount: 0,
    isFirstAssistantResponse: prepared.isFirstAssistantResponse,
    assistantMessageParentId: prepared.assistantMessageParentId,
    preflightThinkingStepCount: prepared.preflightThinkingSteps.length,
    preflightBillingCount: prepared.preflightBilling.length,
    preflightCreditsConsumed,
  };
}

export function buildFinalizeSpanInput(input: {
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
  outcome: DeepAgentTurnOutcome;
  operation: "chat.stream" | "chat.complete";
  latencyMs: number;
}) {
  return {
    operation: input.operation,
    threadId: input.prepared.thread.id,
    userMessageId: input.prepared.userMessage.id,
    parentMessageId: input.prepared.userMessage.parentMessageId,
    assistantContent: input.outcome.assistantContent,
    usage: input.outcome.usage,
    finishReason: input.outcome.finishReason,
    reasoning: input.outcome.reasoning,
    reasoningSegments: buildReasoningSegmentObservations(
      input.outcome.reasoningSegments,
    ),
    citationCount: input.outcome.citations.length,
    availableCitationCount: input.outcome.availableCitations.length,
    citations: buildCitationObservations(input.outcome.citations),
    availableCitations: buildCitationObservations(
      input.outcome.availableCitations,
    ),
    toolCallCount: input.outcome.toolCalls.length,
    retrievalCallCount: input.outcome.retrievalCalls.length,
    thinkingStepCount: input.outcome.thinkingSteps.length,
    renderBlockCount: input.outcome.renderBlocks?.length ?? 0,
    reasoningSegmentCount: input.outcome.reasoningSegments.length,
    latencyMs: input.latencyMs,
  };
}

export async function startThreadTrace(input: {
  trace: TraceContext;
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
  operation: "chat.stream" | "chat.complete";
}) {
  await threadStreamObservability.startTrace({
    ...input.trace,
    name: "thread.stream",
    feature: "chat",
    sessionId: input.trace.sessionId,
    input: buildTraceInput(input.prepared),
    metadata: buildTraceMetadata(input),
  });
}

export async function observePrepareFailure(input: {
  request: StreamThreadEventInput;
  operation: "chat.stream" | "chat.complete";
  startedAt: Date;
  error: unknown;
}) {
  const contentError = toObservationError(input.error);
  try {
    const workspace = await requireContentWorkspace({
      workspaceId: input.request.workspaceId,
      userId: input.request.userId,
    });
    const traceId = `thread-run:${randomUUID()}`;
    await threadStreamObservability.startTrace({
      traceId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.request.userId,
      threadId: input.request.threadId,
      sessionId: input.request.threadId,
      name: "thread.stream",
      feature: "chat",
      input: {
        message: input.request.content,
        mentionedSourceIds: input.request.mentionedSourceIds ?? [],
        sourceIds: input.request.sourceIds ?? [],
        skillIds: input.request.tools?.skillIds ?? [],
        threadId: input.request.threadId,
      },
      metadata: {
        operation: input.operation,
        stage: "thread.prepare",
      },
      startedAt: input.startedAt,
    });
    await threadStreamObservability.endTrace({
      traceId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      status: "error",
      latencyMs: Date.now() - input.startedAt.getTime(),
      errorCode: contentError.code,
      errorMessage: contentError.message,
      metadata: {
        operation: input.operation,
        stage: "thread.prepare",
      },
    });
  } catch (observeError) {
    logger.debug("Failed to observe thread prepare failure", {
      workspaceId: input.request.workspaceId,
      threadId: input.request.threadId,
      error:
        observeError instanceof Error
          ? observeError.message
          : String(observeError),
    });
  }
}

export async function endAgentRunSpanIfOpen(input: {
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
  started: boolean;
  completed: boolean;
  status: "ok" | "error" | "cancelled";
  latencyMs: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!input.started || input.completed) {
    return;
  }
  await threadStreamObservability.endSpan({
    traceId: input.prepared.traceContext!.traceId,
    teamId: input.prepared.traceContext!.teamId,
    workspaceId: input.prepared.traceContext!.workspaceId,
    spanId: "agent_run",
    status: input.status,
    latencyMs: input.latencyMs,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    metadata: input.metadata,
  });
}

export async function endThreadTraceIfOpen(input: {
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
  ended: boolean;
  operation: "chat.stream" | "chat.complete";
  status: "ok" | "error" | "cancelled";
  latencyMs: number;
  outcome?: DeepAgentTurnOutcome | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (input.ended) {
    return false;
  }
  await threadStreamObservability.endTrace({
    traceId: input.prepared.traceContext!.traceId,
    teamId: input.prepared.traceContext!.teamId,
    workspaceId: input.prepared.traceContext!.workspaceId,
    status: input.status,
    latencyMs: input.latencyMs,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    output:
      input.status === "ok" && input.outcome
        ? buildTraceOutput(input.outcome)
        : undefined,
    metadata: {
      ...buildTraceMetadata({
        prepared: input.prepared,
        operation: input.operation,
      }),
      ...(input.metadata ?? {}),
    },
  });
  return true;
}

export async function withObservedSpan<T>(input: {
  trace: TraceContext;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "agent" | "system";
  operation: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  output?: (value: T) => unknown;
  execute: () => Promise<T>;
}) {
  const startedAt = Date.now();
  await threadStreamObservability.startSpan({
    ...input.trace,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    name: input.name,
    kind: input.kind,
    operation: input.operation,
    input: input.input,
    metadata: input.metadata,
  });
  try {
    const output = await input.execute();
    await threadStreamObservability.endSpan({
      traceId: input.trace.traceId,
      teamId: input.trace.teamId,
      workspaceId: input.trace.workspaceId,
      spanId: input.spanId,
      status: "ok",
      latencyMs: Date.now() - startedAt,
      output: input.output?.(output),
    });
    return output;
  } catch (error) {
    await threadStreamObservability.endSpan({
      traceId: input.trace.traceId,
      teamId: input.trace.teamId,
      workspaceId: input.trace.workspaceId,
      spanId: input.spanId,
      status: "error",
      latencyMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
