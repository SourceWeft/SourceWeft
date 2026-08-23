import { randomUUID } from "node:crypto";
import {
  isPendingToolConfirmation,
  toolConfirmationRequestSchema,
  type MeterConsumeResponse,
} from "@sourceweft/contracts";
import type { Job } from "bullmq";
import { getJobsQueueEvents } from "../../../shared/queue";
import {
  invokeDeepAgentTurn,
  type DeepAgentTurnOutcome,
} from "../agent/turn/runner";
import { createRunCancellationGate } from "../run-cancellation";
import { agentSandboxService } from "../agent/sandbox-service/service";
import { DEEPAGENTS_WRITE_TODOS_TOOL_NAME } from "../agent/turn/tool-tracker";
import type { AgentCitation } from "../agent/citation-registry";
import type {
  EmbeddingVectorStrategy,
  MessageRecord,
} from "../../content/types";
import type { ContentBillingPort } from "../../content/billing-port";
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
import {
  type ContentThreadTurnService,
  type PreparedThreadTurn,
  type StreamThreadEventInput,
} from "../turn/service";
import { mapDeepAgentEventToSse } from "./event-mapper";
import {
  createThreadStreamErrorMessage,
  recordThreadStreamFailure,
  rollbackCreatedUserMessage,
  type ThreadStreamPartialErrorState,
} from "./error";
import { toSseData } from "./helpers";
import {
  resolveEditThreadStreamInput,
  resolveRefreshThreadStreamInput,
  resolveResumeThreadStreamInput,
} from "./input";
import type {
  EditThreadInput,
  RefreshThreadInput,
  ResumeThreadInput,
} from "./types";
import type {
  ThreadTitleGenerateJobPayload,
  ThreadTitleGenerateJobResult,
} from "../../content/queue";
import type {
  MessageRenderBlock,
  MeteredLlmCallTrace,
  ModelReasoningSegmentTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../turn/types";
import type { BillingScope } from "../../../shared/model-gateway/index";
import {
  normalizeTraceParts,
  tracePartFromReasoningSegment,
  tracePartFromThinkingStep,
  tracePartFromToolCall,
  type TracePart,
  upsertTracePart,
} from "../turn/trace-parts";
import {
  buildTerminalAssistantTraceState,
  terminalizeToolCall,
} from "../turn/assistant-run-terminal-state";
import {
  isSandboxExecuteToolCallIdRequiredError,
  sandboxExecuteToolCallIdRequiredContentError,
} from "../turn/sandbox-execute-error";

type ThreadTitleJob = Job<Record<string, unknown>, unknown, string>;

type ThreadTitleJobCompletion = {
  jobId: string;
  result: ThreadTitleGenerateJobResult | null;
};

function resolveToolConfirmationFinishPayload(outcome: DeepAgentTurnOutcome) {
  if (outcome.finishReason !== "tool_confirmation_requested") {
    return {};
  }

  const liveConfirmations = outcome.toolCalls
    .map((toolCall) => {
      const confirmation = toolConfirmationRequestSchema.safeParse(
        toolCall.output,
      );
      if (
        !confirmation.success ||
        !isPendingToolConfirmation(confirmation.data)
      ) {
        return null;
      }
      return {
        confirmation: confirmation.data,
        toolCall,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (liveConfirmations.length === 0) {
    throw new ContentError(
      500,
      "TOOL_CONFIRMATION_PAYLOAD_MISSING",
      "Tool confirmation finish is missing confirmation payload.",
    );
  }

  return { liveConfirmations };
}

export type ThreadStreamRunOptions = {
  onPrepared?: (prepared: PreparedThreadTurn) => Promise<{
    assistantMessageId?: string | null;
    assistantMetadata?: Record<string, unknown>;
  } | void>;
  shouldCancel?: () => Promise<boolean>;
  /**
   * Aborts the in-flight agent turn (LLM stream and signal-aware tools) the
   * instant a cancel arrives, so a turn does not run to completion after Stop.
   * `shouldCancel` remains the between-events poll; this is the interrupt.
   */
  abortSignal?: AbortSignal;
  createErrorMessage?: typeof createThreadStreamErrorMessage;
  onFinalized?: (result: {
    assistantMessage: MessageRecord;
    billing: MeterConsumeResponse;
    retrieval: {
      embeddingProfileId: string | null;
      vectorStrategy: EmbeddingVectorStrategy | null;
      annIndexUsed: string | null;
      citations: AgentCitation[];
      availableCitations: AgentCitation[];
    };
  }) => Promise<void> | void;
};

const OBSERVE_CITATION_EXCERPT_CHARS = 320;
const OBSERVE_CITATION_QUOTE_CHARS = 400;

export const threadStreamObservability = {
  startTrace,
  endTrace,
  startSpan,
  endSpan,
};

function buildThreadTraceContext(
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

function toObservationError(error: unknown) {
  if (error instanceof ContentError) {
    return error;
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
  return toContentError(error);
}

function isClientCancelledError(error: ContentError) {
  return error.code === "CLIENT_CANCELLED";
}

async function throwIfClientCancelled(
  shouldCancel: ThreadStreamRunOptions["shouldCancel"],
  abortSignal?: AbortSignal,
) {
  if (abortSignal?.aborted || (await shouldCancel?.())) {
    throw new ContentError(499, "CLIENT_CANCELLED", "Chat run was cancelled");
  }
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

function isVisibleTracePart(part: TracePart) {
  return part.kind !== "tool" || part.tool !== DEEPAGENTS_WRITE_TODOS_TOOL_NAME;
}

function upsertToolCallTrace(
  callsById: Map<string, ToolCallTrace>,
  toolCall: ToolCallTrace,
) {
  const existing = callsById.get(toolCall.id);
  const approvalState = toolCall.approvalState ?? existing?.approvalState;
  const approvalConfirmationId =
    toolCall.approvalConfirmationId ?? existing?.approvalConfirmationId;
  callsById.set(toolCall.id, {
    ...(existing ?? {}),
    ...toolCall,
    ...(approvalState ? { approvalState } : {}),
    ...(approvalConfirmationId ? { approvalConfirmationId } : {}),
  });
}

function upsertThinkingStepTrace(
  stepsById: Map<string, ThinkingStepTrace>,
  step: ThinkingStepTrace,
) {
  const existing = stepsById.get(step.id);
  if (!existing || step.kind !== "log") {
    stepsById.set(step.id, step);
    return;
  }

  stepsById.set(step.id, {
    ...existing,
    status: step.status,
    description: step.description ?? existing.description,
    detail: step.detail ?? existing.detail,
    items: step.items.length > 0 ? step.items : existing.items,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(step.metadata ?? {}),
    },
  });
}

function getThinkingStepStreamKey(step: ThinkingStepTrace) {
  return `${step.id}:${step.status}:${step.title}`;
}

function createPreflightThinkingStepQueue() {
  const queuedSteps: ThinkingStepTrace[] = [];
  const waitingResolvers: Array<
    (result: IteratorResult<ThinkingStepTrace>) => void
  > = [];
  let closed = false;

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      while (waitingResolvers.length > 0) {
        waitingResolvers.shift()?.({
          done: true,
          value: undefined,
        });
      }
    },
    next(): Promise<IteratorResult<ThinkingStepTrace>> {
      const step = queuedSteps.shift();
      if (step) {
        return Promise.resolve({ done: false, value: step });
      }
      if (closed) {
        return Promise.resolve({
          done: true,
          value: undefined,
        });
      }
      return new Promise((resolve) => {
        waitingResolvers.push(resolve);
      });
    },
    push(step: ThinkingStepTrace) {
      if (closed) {
        return;
      }
      const resolve = waitingResolvers.shift();
      if (resolve) {
        resolve({ done: false, value: step });
        return;
      }
      queuedSteps.push(step);
    },
  };
}

function waitForPrepareOrPreflightStep(input: {
  preparePromise: Promise<PreparedThreadTurn>;
  preflightStepQueue: ReturnType<typeof createPreflightThinkingStepQueue>;
}): Promise<
  | { type: "prepared"; prepared: PreparedThreadTurn }
  | { type: "preflight-step"; result: IteratorResult<ThinkingStepTrace> }
> {
  return Promise.race([
    input.preparePromise.then((prepared) => ({
      type: "prepared" as const,
      prepared,
    })),
    input.preflightStepQueue.next().then((result) => ({
      type: "preflight-step" as const,
      result,
    })),
  ]);
}

function appendReasoningChunk(current: string | undefined, next: string) {
  if (!current) {
    return next;
  }
  if (next === current) {
    return current;
  }
  if (next.startsWith(current)) {
    return next;
  }
  return `${current}${next}`;
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

function isSameReasoningSegment(
  existing: ModelReasoningSegmentTrace | undefined,
  next: ModelReasoningSegmentTrace,
) {
  return (
    existing?.id === next.id &&
    typeof existing.text === "string" &&
    typeof next.text === "string"
  );
}

function upsertReasoningSegmentTrace(
  segmentsById: Map<string, ModelReasoningSegmentTrace>,
  next: ModelReasoningSegmentTrace,
) {
  if (isSameReasoningSegment(segmentsById.get(next.id), next)) {
    const existing = segmentsById.get(next.id);
    segmentsById.set(next.id, {
      ...(existing ?? next),
      ...next,
      id: next.id,
      sequence: existing?.sequence ?? next.sequence,
    });
    return;
  }

  if (!segmentsById.has(next.id)) {
    segmentsById.set(next.id, next);
    return;
  }

  let suffix = 2;
  let nextId = `${next.id}:${suffix}`;
  while (segmentsById.has(nextId)) {
    suffix += 1;
    nextId = `${next.id}:${suffix}`;
  }
  segmentsById.set(nextId, {
    ...next,
    id: nextId,
  });
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

function buildPartialErrorState(input: {
  preflightThinkingSteps?: ThinkingStepTrace[];
  reasoning?: string;
  reasoningSegmentsById: Map<string, ModelReasoningSegmentTrace>;
  traceParts: TracePart[];
  toolCallsById: Map<string, ToolCallTrace>;
  thinkingStepsById: Map<string, ThinkingStepTrace>;
  renderBlocks?: MessageRenderBlock[];
  citations: AgentCitation[];
  availableCitations: AgentCitation[];
  meteredLlmCalls: MeteredLlmCallTrace[];
}): ThreadStreamPartialErrorState {
  const terminalTraceState = buildTerminalAssistantTraceState({
    mode: "error",
    preflightThinkingSteps: input.preflightThinkingSteps ?? [],
    runtimeThinkingSteps: [...input.thinkingStepsById.values()],
    traceParts: input.traceParts,
  });
  return {
    reasoning: input.reasoning,
    reasoningSegments: [...input.reasoningSegmentsById.values()],
    traceParts: terminalTraceState.traceParts.filter(isVisibleTracePart),
    toolCalls: [...input.toolCallsById.values()].map((toolCall) =>
      terminalizeToolCall({ mode: "error", toolCall }),
    ),
    thinkingSteps: terminalTraceState.thinkingSteps,
    renderBlocks: input.renderBlocks,
    citations: input.citations,
    availableCitations: input.availableCitations,
    meteredLlmCalls: input.meteredLlmCalls,
  };
}

function buildTerminalTraceState(input: {
  preflightThinkingSteps: ThinkingStepTrace[];
  runtimeThinkingSteps: ThinkingStepTrace[];
  traceParts: TracePart[];
}) {
  const terminalTraceState = buildTerminalAssistantTraceState({
    mode: "success",
    preflightThinkingSteps: input.preflightThinkingSteps,
    runtimeThinkingSteps: input.runtimeThinkingSteps,
    traceParts: input.traceParts,
  });
  return {
    thinkingSteps: terminalTraceState.thinkingSteps,
    traceParts: terminalTraceState.traceParts.filter(isVisibleTracePart),
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

function buildPrepareSpanInput(
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

function buildPrepareSpanOutput(
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

function buildFinalizeSpanInput(input: {
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

async function startThreadTrace(input: {
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

async function observePrepareFailure(input: {
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

async function endAgentRunSpanIfOpen(input: {
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

async function endThreadTraceIfOpen(input: {
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

async function withObservedSpan<T>(input: {
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

function shouldGenerateAutomaticThreadTitle(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return prepared.isFirstAssistantResponse && prepared.isFirstAssistantAttempt;
}

function isThreadTitleGenerateJobResult(
  value: unknown,
): value is ThreadTitleGenerateJobResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    (result.status === "applied" || result.status === "skipped") &&
    typeof result.threadId === "string"
  );
}

function titleCompletionToUpdate(completion: ThreadTitleJobCompletion) {
  return completion.result?.status === "applied"
    ? {
        id: completion.result.threadId,
        title: completion.result.title,
      }
    : null;
}

async function waitForThreadTitleJob(input: {
  job: ThreadTitleJob;
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
}): Promise<ThreadTitleJobCompletion> {
  const jobId = String(input.job.id);
  try {
    const waitUntilFinished = input.job.waitUntilFinished.bind(input.job) as (
      queueEvents?: ReturnType<typeof getJobsQueueEvents>,
    ) => Promise<unknown>;
    const result =
      waitUntilFinished.length === 0
        ? await waitUntilFinished()
        : await waitUntilFinished(getJobsQueueEvents());
    return {
      jobId,
      result: isThreadTitleGenerateJobResult(result) ? result : null,
    };
  } catch (error) {
    logger.warn("Automatic thread title job failed", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { jobId, result: null };
  }
}

async function enqueueAutomaticThreadTitleJob(input: {
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>;
}): Promise<ThreadTitleJob | null> {
  if (!shouldGenerateAutomaticThreadTitle(input.prepared)) {
    return null;
  }

  const { enqueueThreadTitleGenerateJob } = await import("../../content/queue");
  const payload: ThreadTitleGenerateJobPayload = {
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    traceId: input.prepared.traceContext?.traceId,
    userId: input.prepared.userId,
    userMessageId: input.prepared.userMessage.id,
    messageContent: input.prepared.messageContent,
    profileAlias: input.prepared.profileAlias,
    modelAlias: input.prepared.modelAlias,
    providerModel: input.prepared.providerModel,
    gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
    expectedTitle: input.prepared.initialTitle,
    thinking: input.prepared.llm?.thinking,
    ...(input.prepared.llm?.executionMode === "BYOK" &&
    input.prepared.llm.byokModelId
      ? {
          llm: {
            executionMode: "BYOK" as const,
            byokModelId: input.prepared.llm.byokModelId,
            credentialId: input.prepared.llm.credentialId,
            providerHint: input.prepared.llm.providerHint,
            providerModel: input.prepared.llm.providerModel,
            modelAlias: input.prepared.llm.modelAlias,
          },
        }
      : {}),
  };

  return enqueueThreadTitleGenerateJob(payload).catch((error: unknown) => {
    logger.warn("Failed to enqueue automatic thread title job", {
      threadId: input.prepared.thread.id,
      userMessageId: input.prepared.userMessage.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
}

class ContentThreadStreamService {
  private readonly billing: ContentBillingPort;

  constructor(
    private readonly turnService: ContentThreadTurnService,
    private readonly invokeAgentTurn = invokeDeepAgentTurn,
    private readonly enqueueTitleJob = enqueueAutomaticThreadTitleJob,
    private readonly createErrorMessage = createThreadStreamErrorMessage,
    /**
     * Required. This used to be optional with a no-op fallback that reported
     * billingMode "disabled" and metered nothing, so a construction site that
     * forgot to wire billing silently gave usage away instead of failing.
     */
    billing: ContentBillingPort,
  ) {
    this.billing = billing;
  }

  async refreshThread(input: RefreshThreadInput) {
    return this.streamThread(await resolveRefreshThreadStreamInput(input));
  }

  async *refreshThreadEvents(
    input: RefreshThreadInput,
    options?: ThreadStreamRunOptions,
  ): AsyncGenerator<string> {
    yield* this.streamThreadEvents(
      await resolveRefreshThreadStreamInput(input),
      options,
    );
  }

  async resumeThread(input: ResumeThreadInput) {
    return this.streamThread(await resolveResumeThreadStreamInput(input));
  }

  async *resumeThreadEvents(
    input: ResumeThreadInput,
    options?: ThreadStreamRunOptions,
  ): AsyncGenerator<string> {
    yield* this.streamThreadEvents(
      await resolveResumeThreadStreamInput(input),
      options,
    );
  }

  async editThread(input: EditThreadInput) {
    return this.streamThread(await resolveEditThreadStreamInput(input));
  }

  async *editThreadEvents(
    input: EditThreadInput,
    options?: ThreadStreamRunOptions,
  ): AsyncGenerator<string> {
    yield* this.streamThreadEvents(
      await resolveEditThreadStreamInput(input),
      options,
    );
  }

  async *streamThreadEvents(
    input: StreamThreadEventInput,
    options: ThreadStreamRunOptions = {},
  ): AsyncGenerator<string> {
    const prepareStartedAt = new Date();
    const preflightStepQueue = createPreflightThinkingStepQueue();
    const emittedPreflightStepKeys = new Set<string>();
    const preparePromise = this.turnService
      .prepareThreadTurn({
        ...input,
        onPreflightThinkingStep: (step) => {
          input.onPreflightThinkingStep?.(step);
          preflightStepQueue.push(step);
        },
      })
      .catch(async (error: unknown) => {
        await observePrepareFailure({
          request: input,
          operation: "chat.stream",
          startedAt: prepareStartedAt,
          error,
        });
        throw error;
      })
      .finally(() => {
        preflightStepQueue.close();
      });
    let prepareResult = await waitForPrepareOrPreflightStep({
      preparePromise,
      preflightStepQueue,
    });
    while (prepareResult.type !== "prepared") {
      if (!prepareResult.result.done) {
        const step = prepareResult.result.value;
        emittedPreflightStepKeys.add(getThinkingStepStreamKey(step));
        yield toSseData({
          type: "thinking-step",
          step,
        });
      }
      prepareResult = await waitForPrepareOrPreflightStep({
        preparePromise,
        preflightStepQueue,
      });
    }
    const prepared = prepareResult.prepared;
    const preparedOptions = await options.onPrepared?.(prepared);
    const assistantMessageId =
      prepared.assistantMessageId ??
      preparedOptions?.assistantMessageId ??
      undefined;
    const assistantMetadata = preparedOptions?.assistantMetadata;
    const prepareEndedAt = new Date();
    prepared.traceContext = buildThreadTraceContext(prepared);
    await startThreadTrace({
      trace: prepared.traceContext,
      prepared,
      operation: "chat.stream",
    });
    const chatStartedAt = Date.now();
    await threadStreamObservability.startSpan({
      ...prepared.traceContext,
      spanId: "prepare_thread_turn",
      name: "prepare_thread_turn",
      kind: "system",
      operation: "thread.prepare",
      startedAt: prepareStartedAt,
      input: buildPrepareSpanInput(prepared),
      metadata: {
        operation: "chat.stream",
        modelAlias: prepared.modelAlias,
        ...(prepared.llm?.executionMode === "BYOK"
          ? {}
          : { profileAlias: prepared.profileAlias }),
      },
    });
    await threadStreamObservability.endSpan({
      traceId: prepared.traceContext.traceId,
      teamId: prepared.traceContext.teamId,
      workspaceId: prepared.traceContext.workspaceId,
      spanId: "prepare_thread_turn",
      status: "ok",
      endedAt: prepareEndedAt,
      latencyMs: prepareEndedAt.getTime() - prepareStartedAt.getTime(),
      output: buildPrepareSpanOutput(prepared),
    });

    const textId = `text-${prepared.userMessage.id}`;
    let traceEnded = false;
    let agentSpanStarted = false;
    let agentSpanCompleted = false;
    let outcome: DeepAgentTurnOutcome | null = null;
    let assistantContent = "";
    let reasoning: string | undefined;
    const reasoningSegmentsById = new Map<string, ModelReasoningSegmentTrace>();
    let traceParts: TracePart[] = normalizeTraceParts(
      prepared.traceContinuation?.traceParts,
    );
    const toolCallsById = new Map<string, ToolCallTrace>();
    const thinkingStepsById = new Map<string, ThinkingStepTrace>();
    for (const step of prepared.preflightThinkingSteps) {
      upsertThinkingStepTrace(thinkingStepsById, step);
      traceParts = upsertTracePart(traceParts, tracePartFromThinkingStep(step));
    }
    let citations: AgentCitation[] = [];
    let availableCitations: AgentCitation[] = [];
    // The turn's billing scope, captured as soon as the agent opens it. On the
    // failure path no outcome is ever produced, so this is the only thing that
    // still knows what the turn metered before it threw.
    let billingScope: BillingScope | null = null;
    const meteredLlmCallsOnFailure = () => [
      ...(billingScope?.meteredCalls() ?? []),
    ];
    let responseFinished = false;
    let persistedErrorMessage = false;
    let finalizedAssistantMessage: MessageRecord | null = null;
    try {
      const preparedThreadRun =
        assistantMetadata &&
        typeof assistantMetadata.threadRun === "object" &&
        assistantMetadata.threadRun !== null
          ? {
              ...(assistantMetadata.threadRun as Record<string, unknown>),
              ...(assistantMessageId ? { assistantMessageId } : {}),
            }
          : undefined;
      yield toSseData({
        type: "start",
        messageId: prepared.userMessage.id,
        threadRun: preparedThreadRun,
        mentionedSourceIds: prepared.mentionedSourceIds,
        effectiveMentionedSourceIds: prepared.effectiveMentionedSourceIds,
        sourceIds: prepared.selectedSourceIds,
        effectiveSourceIds: prepared.sourceIds,
        contentJson: prepared.userMessage.contentJson,
        ...(prepared.command
          ? {
              command: {
                name: prepared.command.canonicalName,
                arguments: prepared.command.arguments,
                kind: prepared.command.kind,
                displayName: prepared.command.displayName,
                ...(prepared.command.path
                  ? { path: prepared.command.path }
                  : {}),
                ...(prepared.command.toolName
                  ? { toolName: prepared.command.toolName }
                  : {}),
              },
            }
          : {}),
      });
      yield toSseData({ type: "text-start", id: textId });
      for (const step of prepared.preflightThinkingSteps) {
        const stepKey = getThinkingStepStreamKey(step);
        if (emittedPreflightStepKeys.has(stepKey)) {
          continue;
        }
        emittedPreflightStepKeys.add(stepKey);
        yield toSseData({
          type: "thinking-step",
          step,
        });
      }

      const titleUpdates: Array<{ id: string; title: string }> = [];
      let titleUpdateEmitted = false;
      const titleJob = shouldGenerateAutomaticThreadTitle(prepared)
        ? await this.enqueueTitleJob({ prepared })
        : null;
      const titleJobId = titleJob?.id ? String(titleJob.id) : undefined;

      const emitTitleUpdates = function* () {
        while (titleUpdates.length > 0) {
          const update = titleUpdates.shift()!;
          titleUpdateEmitted = true;
          yield toSseData({
            type: "thread-title-update",
            threadId: update.id,
            title: update.title,
          });
        }
      };

      try {
        const agentEvents = this.invokeAgentTurn({
          prepared,
          billing: this.billing,
          onBillingScope: (scope) => {
            billingScope = scope;
          },
          llm: prepared.llm,
          traceContext: {
            ...prepared.traceContext,
            parentSpanId: "agent_run",
          },
          operation: "chat.stream",
          abortSignal: options.abortSignal,
          runCancellation: createRunCancellationGate({
            shouldCancel: options.shouldCancel,
            signal: options.abortSignal,
          }),
        });
        await threadStreamObservability.startSpan({
          ...prepared.traceContext,
          spanId: "agent_run",
          name: "agent_run",
          kind: "agent",
          operation: "agent.run",
          input: {
            message: prepared.messageContent,
            modelAlias: prepared.modelAlias,
            ...(prepared.llm?.executionMode === "BYOK"
              ? {}
              : { profileAlias: prepared.profileAlias }),
            sourceCount: prepared.selectedSourceIds.length,
            effectiveSourceCount: prepared.sourceIds.length,
          },
          metadata: {
            ...buildAgentRunSpanMetadata(prepared),
          },
        });
        agentSpanStarted = true;
        let nextAgentEvent = agentEvents.next();
        let titleSettled = false;
        let titleResolvedCompletion: ThreadTitleJobCompletion | null = null;
        const titleCompletion: Promise<ThreadTitleJobCompletion> | null =
          titleJob
            ? waitForThreadTitleJob({ job: titleJob, prepared }).then(
                (completion) => {
                  titleSettled = true;
                  titleResolvedCompletion = completion;
                  return completion;
                },
              )
            : null;
        let nextTitleEvent: Promise<ThreadTitleJobCompletion> | null =
          titleCompletion;

        while (true) {
          const raceNext = () =>
            Promise.race([
              nextAgentEvent.then((value) => ({
                type: "agent" as const,
                value,
              })),
              ...(nextTitleEvent
                ? [
                    nextTitleEvent.then((value) => ({
                      type: "title" as const,
                      value,
                    })),
                  ]
                : []),
            ]);
          let result: Awaited<ReturnType<typeof raceNext>>;
          try {
            result = await raceNext();
          } catch (error) {
            // Aborting the agent stream surfaces as an AbortError here, which
            // `toDurableRunContentError` would otherwise record as a failure.
            // When the abort was a cancel, report it as one.
            if (
              options.abortSignal?.aborted ||
              (await options.shouldCancel?.())
            ) {
              throw new ContentError(
                499,
                "CLIENT_CANCELLED",
                "Chat run was cancelled",
              );
            }
            throw error;
          }

          if (result.type === "title") {
            await throwIfClientCancelled(
              options.shouldCancel,
              options.abortSignal,
            );
            nextTitleEvent = null;
            const update = titleCompletionToUpdate(result.value);
            if (update) {
              titleUpdates.push(update);
            }
            titleResolvedCompletion = null;
            yield* emitTitleUpdates();
            continue;
          }

          const { value: event, done } = result.value;
          if (done) {
            break;
          }

          nextAgentEvent = agentEvents.next();
          await throwIfClientCancelled(
            options.shouldCancel,
            options.abortSignal,
          );
          if (event.type === "done") {
            outcome = {
              ...event.outcome,
              meteredLlmCalls:
                event.outcome.meteredLlmCalls ?? meteredLlmCallsOnFailure(),
            };
            continue;
          }

          if (event.type === "text-delta") {
            assistantContent += event.delta;
          }
          if (event.type === "text-replace") {
            assistantContent = event.text;
          }
          if (event.type === "reasoning") {
            reasoning = appendReasoningChunk(reasoning, event.reasoning);
            upsertReasoningSegmentTrace(reasoningSegmentsById, event.segment);
            traceParts = upsertTracePart(
              traceParts,
              tracePartFromReasoningSegment(event.segment),
            );
          }
          if (
            event.type === "tool-call-start" ||
            event.type === "tool-call-event" ||
            event.type === "tool-call-result" ||
            event.type === "tool-call-error" ||
            event.type === "tool-call-end"
          ) {
            upsertToolCallTrace(toolCallsById, event.toolCall);
            traceParts = upsertTracePart(
              traceParts,
              tracePartFromToolCall(event.toolCall),
            );
          }
          if (event.type === "thinking-step") {
            upsertThinkingStepTrace(thinkingStepsById, event.step);
            traceParts = upsertTracePart(
              traceParts,
              tracePartFromThinkingStep(event.step),
            );
          }
          if (event.type === "citations") {
            citations = event.citations;
            availableCitations = event.availableCitations ?? event.citations;
          }

          const sse = mapDeepAgentEventToSse(event, textId);
          if (sse !== null) {
            yield sse;
          }
          yield* emitTitleUpdates();
        }

        await throwIfClientCancelled(options.shouldCancel, options.abortSignal);
        if (!outcome) {
          throw new ContentError(
            502,
            "MODEL_EMPTY_RESPONSE",
            "Model returned no response",
          );
        }
        const completedOutcome = outcome;
        const terminalTraceState = buildTerminalTraceState({
          preflightThinkingSteps: prepared.preflightThinkingSteps,
          runtimeThinkingSteps: completedOutcome.thinkingSteps,
          traceParts,
        });

        await threadStreamObservability.endSpan({
          traceId: prepared.traceContext.traceId,
          teamId: prepared.traceContext.teamId,
          workspaceId: prepared.traceContext.workspaceId,
          spanId: "agent_run",
          status: "ok",
          latencyMs: Date.now() - chatStartedAt,
          output: buildAgentRunSpanOutput(completedOutcome),
        });
        agentSpanCompleted = true;

        await throwIfClientCancelled(options.shouldCancel, options.abortSignal);
        const finalized = await withObservedSpan({
          trace: prepared.traceContext,
          spanId: "finalize_thread_turn",
          name: "finalize_thread_turn",
          kind: "system",
          operation: "thread.finalize",
          input: buildFinalizeSpanInput({
            prepared,
            outcome: completedOutcome,
            operation: "chat.stream",
            latencyMs: Date.now() - chatStartedAt,
          }),
          output: (result) => ({
            assistantMessageId: result.assistantMessage.id,
            parentMessageId: result.assistantMessage.parentMessageId,
            contentLength: completedOutcome.assistantContent.length,
            citationCount: completedOutcome.citations.length,
            availableCitationCount: completedOutcome.availableCitations.length,
            toolCallCount: completedOutcome.toolCalls.length,
            retrievalCallCount: completedOutcome.retrievalCalls.length,
            saved: true,
          }),
          execute: () =>
            this.turnService.finalizeThreadTurn({
              prepared,
              retrieval: completedOutcome.retrieval,
              citations: completedOutcome.citations,
              availableCitations: completedOutcome.availableCitations,
              retrievalCalls: completedOutcome.retrievalCalls,
              toolCalls: completedOutcome.toolCalls,
              meteredLlmCalls:
                completedOutcome.meteredLlmCalls ?? meteredLlmCallsOnFailure(),
              thinkingSteps: terminalTraceState.thinkingSteps,
              renderBlocks: completedOutcome.renderBlocks,
              reasoningSegments: completedOutcome.reasoningSegments,
              traceParts: terminalTraceState.traceParts,
              llm: prepared.llm,
              operation: "chat.stream",
              assistantContent: completedOutcome.assistantContent,
              usage: completedOutcome.usage,
              finishReason: completedOutcome.finishReason ?? "stop",
              reasoning: completedOutcome.reasoning,
              agentCheckpoint: completedOutcome.agentCheckpoint,
              latencyMs: Date.now() - chatStartedAt,
              assistantMessageId,
              assistantMetadata,
            }),
        });
        await options.onFinalized?.({
          ...finalized,
          retrieval: {
            embeddingProfileId: completedOutcome.retrieval?.profile.id ?? null,
            vectorStrategy:
              completedOutcome.retrieval?.planner.strategy ?? null,
            annIndexUsed:
              completedOutcome.retrieval?.planner.annIndexUsed ?? null,
            citations: completedOutcome.citations,
            availableCitations: completedOutcome.availableCitations,
          },
        });
        const { assistantMessage } = finalized;
        finalizedAssistantMessage = assistantMessage;

        yield toSseData({ type: "text-end", id: textId });
        yield toSseData({
          type: "assistant-message",
          messageId: assistantMessage.id,
          userMessageId: prepared.userMessage.id,
          parentMessageId: assistantMessage.parentMessageId,
        });
        if (titleResolvedCompletion) {
          const update = titleCompletionToUpdate(titleResolvedCompletion);
          if (update) {
            titleUpdates.push(update);
          }
          titleResolvedCompletion = null;
        }
        yield* emitTitleUpdates();
        if (titleJob && !titleSettled && !titleUpdateEmitted) {
          yield toSseData({
            type: "thread-title-pending",
            threadId: prepared.thread.id,
            jobId: titleJobId,
          });
        }
      } catch (error) {
        const contentError = toObservationError(error);
        const isClientCancelled = isClientCancelledError(contentError);

        if (!isClientCancelled) {
          await recordThreadStreamFailure({
            prepared,
            contentError,
            operation: "chat.stream",
            llm: prepared.llm,
          });
        }
        const createErrorMessage =
          options.createErrorMessage ?? this.createErrorMessage;
        const errorMessage = await createErrorMessage({
          prepared,
          contentError,
          partialAssistantContent: assistantContent,
          partialState: buildPartialErrorState({
            preflightThinkingSteps: prepared.preflightThinkingSteps,
            reasoning,
            reasoningSegmentsById,
            traceParts,
            toolCallsById,
            thinkingStepsById,
            renderBlocks: outcome?.renderBlocks,
            citations,
            availableCitations,
            meteredLlmCalls: meteredLlmCallsOnFailure(),
          }),
        });
        persistedErrorMessage = Boolean(errorMessage);
        if (
          !errorMessage &&
          prepared.failurePersistence === "persist-error-turn"
        ) {
          await rollbackCreatedUserMessage({ prepared });
        }
        await endAgentRunSpanIfOpen({
          prepared,
          started: agentSpanStarted,
          completed: agentSpanCompleted,
          status: isClientCancelled ? "cancelled" : "error",
          latencyMs: Date.now() - chatStartedAt,
          errorCode: contentError.code,
          errorMessage: contentError.message,
          metadata: isClientCancelled
            ? {
                cancelled: true,
                cancelReason: "client_requested",
                finishReason: "cancelled",
              }
            : undefined,
        });
        agentSpanCompleted = agentSpanCompleted || agentSpanStarted;
        traceEnded =
          (await endThreadTraceIfOpen({
            prepared,
            ended: traceEnded,
            operation: "chat.stream",
            status: isClientCancelled ? "cancelled" : "error",
            latencyMs: Date.now() - chatStartedAt,
            errorCode: contentError.code,
            errorMessage: contentError.message,
            metadata: isClientCancelled
              ? {
                  cancelled: true,
                  cancelReason: "client_requested",
                  finishReason: "cancelled",
                }
              : undefined,
          })) || traceEnded;

        yield toSseData({ type: "text-end", id: textId });

        const clientErrorMessage = sanitizeClientErrorMessage(
          contentError.message,
        );
        yield toSseData({
          type: "error",
          code: contentError.code,
          error: clientErrorMessage,
          userMessageId: prepared.userMessage.id,
          messageId: errorMessage?.id,
          parentMessageId: errorMessage?.parentMessageId,
        });
      }

      if (!traceEnded) {
        traceEnded =
          (await endThreadTraceIfOpen({
            prepared,
            ended: traceEnded,
            operation: "chat.stream",
            status: "ok",
            latencyMs: Date.now() - chatStartedAt,
            outcome,
          })) || traceEnded;
      }
      yield toSseData({
        type: "finish",
        finishReason: outcome?.finishReason ?? "stop",
        ...(finalizedAssistantMessage
          ? {
              messageId: finalizedAssistantMessage.id,
              userMessageId: prepared.userMessage.id,
              parentMessageId: finalizedAssistantMessage.parentMessageId,
            }
          : {}),
        ...(outcome ? resolveToolConfirmationFinishPayload(outcome) : {}),
        ...(outcome?.agentCheckpoint
          ? { agentCheckpoint: outcome.agentCheckpoint }
          : {}),
      });
      responseFinished = true;
    } finally {
      if (!traceEnded) {
        const contentError = new ContentError(
          499,
          "CLIENT_CANCELLED",
          "Client closed the stream before completion",
        );
        if (
          !persistedErrorMessage &&
          !responseFinished &&
          (assistantContent.trimEnd().length > 0 ||
            toolCallsById.size > 0 ||
            thinkingStepsById.size > 0 ||
            reasoningSegmentsById.size > 0 ||
            citations.length > 0)
        ) {
          const createErrorMessage =
            options.createErrorMessage ?? this.createErrorMessage;
          const errorMessage = await createErrorMessage({
            prepared,
            contentError,
            partialAssistantContent: assistantContent,
            partialState: buildPartialErrorState({
              preflightThinkingSteps: prepared.preflightThinkingSteps,
              reasoning,
              reasoningSegmentsById,
              traceParts,
              toolCallsById,
              thinkingStepsById,
              renderBlocks: outcome?.renderBlocks,
              citations,
              availableCitations,
              meteredLlmCalls: meteredLlmCallsOnFailure(),
            }),
          });
          persistedErrorMessage = Boolean(errorMessage);
        }
        await endAgentRunSpanIfOpen({
          prepared,
          started: agentSpanStarted,
          completed: agentSpanCompleted,
          status: "cancelled",
          latencyMs: Date.now() - chatStartedAt,
          errorCode: contentError.code,
          errorMessage: contentError.message,
          metadata: {
            cancelled: true,
            cancelReason: "stream_abandoned",
            finishReason: "cancelled",
          },
        });
        agentSpanCompleted = agentSpanCompleted || agentSpanStarted;
        traceEnded =
          (await endThreadTraceIfOpen({
            prepared,
            ended: traceEnded,
            operation: "chat.stream",
            status: "cancelled",
            latencyMs: Date.now() - chatStartedAt,
            errorCode: contentError.code,
            errorMessage: contentError.message,
            metadata: {
              cancelled: true,
              cancelReason: "stream_abandoned",
              finishReason: "cancelled",
            },
          })) || traceEnded;
        await agentSandboxService
          .releaseThreadSandboxLease({
            context: {
              teamId: prepared.workspace.organizationId,
              workspaceId: prepared.workspace.id,
              threadId: prepared.thread.id,
              userId: prepared.userId,
              messageId: prepared.userMessage.id,
              runId: prepared.runTraceId,
            },
            reason: "stream_abandoned",
          })
          .catch((error: unknown) => {
            logger.warn(
              "Failed to release sandbox lease after stream abandoned",
              {
                workspaceId: prepared.workspace.id,
                threadId: prepared.thread.id,
                userId: prepared.userId,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          });
      }
    }
  }

  async streamThread(input: StreamThreadEventInput) {
    const prepareStartedAt = new Date();
    const prepared = await this.turnService
      .prepareThreadTurn(input)
      .catch(async (error: unknown) => {
        await observePrepareFailure({
          request: input,
          operation: "chat.complete",
          startedAt: prepareStartedAt,
          error,
        });
        throw error;
      });
    const prepareEndedAt = new Date();
    prepared.traceContext = buildThreadTraceContext(prepared);
    await startThreadTrace({
      trace: prepared.traceContext,
      prepared,
      operation: "chat.complete",
    });
    const chatStartedAt = Date.now();
    await threadStreamObservability.startSpan({
      ...prepared.traceContext,
      spanId: "prepare_thread_turn",
      name: "prepare_thread_turn",
      kind: "system",
      operation: "thread.prepare",
      startedAt: prepareStartedAt,
      input: buildPrepareSpanInput(prepared),
      metadata: {
        operation: "chat.complete",
        modelAlias: prepared.modelAlias,
        ...(prepared.llm?.executionMode === "BYOK"
          ? {}
          : { profileAlias: prepared.profileAlias }),
      },
    });
    await threadStreamObservability.endSpan({
      traceId: prepared.traceContext.traceId,
      teamId: prepared.traceContext.teamId,
      workspaceId: prepared.traceContext.workspaceId,
      spanId: "prepare_thread_turn",
      status: "ok",
      endedAt: prepareEndedAt,
      latencyMs: prepareEndedAt.getTime() - prepareStartedAt.getTime(),
      output: buildPrepareSpanOutput(prepared),
    });
    await threadStreamObservability.startSpan({
      ...prepared.traceContext,
      spanId: "agent_run",
      name: "agent_run",
      kind: "agent",
      operation: "agent.run",
      input: {
        message: prepared.messageContent,
        modelAlias: prepared.modelAlias,
        ...(prepared.llm?.executionMode === "BYOK"
          ? {}
          : { profileAlias: prepared.profileAlias }),
        sourceCount: prepared.selectedSourceIds.length,
        effectiveSourceCount: prepared.sourceIds.length,
      },
      metadata: {
        ...buildAgentRunSpanMetadata(prepared),
      },
    });
    let agentSpanCompleted = false;
    let traceEnded = false;
    let outcome: DeepAgentTurnOutcome | null = null;
    // The turn's billing scope, captured as soon as the agent opens it. On the
    // failure path no outcome is ever produced, so this is the only thing that
    // still knows what the turn metered before it threw.
    let billingScope: BillingScope | null = null;
    const meteredLlmCallsOnFailure = () => [
      ...(billingScope?.meteredCalls() ?? []),
    ];
    let traceParts: TracePart[] = prepared.preflightThinkingSteps.reduce<
      TracePart[]
    >(
      (parts, step) => upsertTracePart(parts, tracePartFromThinkingStep(step)),
      normalizeTraceParts(prepared.traceContinuation?.traceParts),
    );

    try {
      outcome = await (async () => {
        let doneOutcome: DeepAgentTurnOutcome | null = null;
        for await (const event of this.invokeAgentTurn({
          prepared,
          billing: this.billing,
          onBillingScope: (scope) => {
            billingScope = scope;
          },
          llm: prepared.llm,
          traceContext: {
            ...prepared.traceContext!,
            parentSpanId: "agent_run",
          },
          operation: "chat.complete",
        })) {
          if (event.type === "reasoning") {
            traceParts = upsertTracePart(
              traceParts,
              tracePartFromReasoningSegment(event.segment),
            );
          }
          if (
            event.type === "tool-call-start" ||
            event.type === "tool-call-event" ||
            event.type === "tool-call-result" ||
            event.type === "tool-call-error" ||
            event.type === "tool-call-end"
          ) {
            traceParts = upsertTracePart(
              traceParts,
              tracePartFromToolCall(event.toolCall),
            );
          }
          if (event.type === "thinking-step") {
            traceParts = upsertTracePart(
              traceParts,
              tracePartFromThinkingStep(event.step),
            );
          }
          if (event.type === "done") {
            doneOutcome = {
              ...event.outcome,
              meteredLlmCalls:
                event.outcome.meteredLlmCalls ?? meteredLlmCallsOnFailure(),
            };
          }
        }

        if (!doneOutcome) {
          throw new ContentError(
            502,
            "MODEL_EMPTY_RESPONSE",
            "Model returned no response",
          );
        }

        return doneOutcome;
      })().catch(async (error: unknown) => {
        const contentError = toObservationError(error);
        await recordThreadStreamFailure({
          prepared,
          contentError,
          operation: "chat.complete",
          llm: prepared.llm,
        });
        const errorMessage = await this.createErrorMessage({
          prepared,
          contentError,
          partialState: {
            thinkingSteps: prepared.preflightThinkingSteps,
            meteredLlmCalls: meteredLlmCallsOnFailure(),
          },
        });
        if (
          !errorMessage &&
          prepared.failurePersistence === "persist-error-turn"
        ) {
          await rollbackCreatedUserMessage({ prepared });
        }
        await endAgentRunSpanIfOpen({
          prepared,
          started: true,
          completed: agentSpanCompleted,
          status: "error",
          latencyMs: Date.now() - chatStartedAt,
          errorCode: contentError.code,
          errorMessage: contentError.message,
        });
        agentSpanCompleted = true;
        traceEnded =
          (await endThreadTraceIfOpen({
            prepared,
            ended: traceEnded,
            operation: "chat.complete",
            status: "error",
            latencyMs: Date.now() - chatStartedAt,
            errorCode: contentError.code,
            errorMessage: contentError.message,
          })) || traceEnded;
        throw contentError;
      });

      const completedOutcome = outcome;
      const terminalTraceState = buildTerminalTraceState({
        preflightThinkingSteps: prepared.preflightThinkingSteps,
        runtimeThinkingSteps: completedOutcome.thinkingSteps,
        traceParts,
      });
      await threadStreamObservability.endSpan({
        traceId: prepared.traceContext.traceId,
        teamId: prepared.traceContext.teamId,
        workspaceId: prepared.traceContext.workspaceId,
        spanId: "agent_run",
        status: "ok",
        latencyMs: Date.now() - chatStartedAt,
        output: buildAgentRunSpanOutput(completedOutcome),
      });
      agentSpanCompleted = true;

      const { assistantMessage, billing } = await withObservedSpan({
        trace: prepared.traceContext,
        spanId: "finalize_thread_turn",
        name: "finalize_thread_turn",
        kind: "system",
        operation: "thread.finalize",
        input: buildFinalizeSpanInput({
          prepared,
          outcome: completedOutcome,
          operation: "chat.complete",
          latencyMs: Date.now() - chatStartedAt,
        }),
        output: (result) => ({
          assistantMessageId: result.assistantMessage.id,
          parentMessageId: result.assistantMessage.parentMessageId,
          contentLength: completedOutcome.assistantContent.length,
          citationCount: completedOutcome.citations.length,
          availableCitationCount: completedOutcome.availableCitations.length,
          toolCallCount: completedOutcome.toolCalls.length,
          retrievalCallCount: completedOutcome.retrievalCalls.length,
          saved: true,
        }),
        execute: () =>
          this.turnService.finalizeThreadTurn({
            prepared,
            retrieval: completedOutcome.retrieval,
            citations: completedOutcome.citations,
            availableCitations: completedOutcome.availableCitations,
            retrievalCalls: completedOutcome.retrievalCalls,
            toolCalls: completedOutcome.toolCalls,
            meteredLlmCalls:
              completedOutcome.meteredLlmCalls ?? meteredLlmCallsOnFailure(),
            thinkingSteps: terminalTraceState.thinkingSteps,
            renderBlocks: completedOutcome.renderBlocks,
            reasoningSegments: completedOutcome.reasoningSegments,
            traceParts: terminalTraceState.traceParts,
            llm: prepared.llm,
            operation: "chat.complete",
            assistantContent: completedOutcome.assistantContent,
            usage: completedOutcome.usage,
            finishReason: completedOutcome.finishReason ?? "stop",
            reasoning: completedOutcome.reasoning,
            agentCheckpoint: completedOutcome.agentCheckpoint,
            latencyMs: Date.now() - chatStartedAt,
            modelForMessage: prepared.modelAlias,
            assistantMessageId: undefined,
          }),
      });

      // Enqueue the title job but don't block the response on it: the worker
      // generates the title and persists it, and clients pick it up on their
      // next thread-list refresh. Blocking here used to hold the whole response
      // open for a second full model round-trip.
      if (shouldGenerateAutomaticThreadTitle(prepared)) {
        await this.enqueueTitleJob({ prepared });
      }

      if (!traceEnded) {
        traceEnded =
          (await endThreadTraceIfOpen({
            prepared,
            ended: traceEnded,
            operation: "chat.complete",
            status: "ok",
            latencyMs: Date.now() - chatStartedAt,
            outcome: completedOutcome,
          })) || traceEnded;
      }

      return {
        thread: prepared.thread,
        userMessage: prepared.userMessage,
        assistantMessage,
        billing,
        retrieval: {
          embeddingProfileId: completedOutcome.retrieval?.profile.id ?? null,
          vectorStrategy: completedOutcome.retrieval?.planner.strategy ?? null,
          annIndexUsed:
            completedOutcome.retrieval?.planner.annIndexUsed ?? null,
          citations: completedOutcome.citations,
          availableCitations: completedOutcome.availableCitations,
        },
      };
    } catch (error) {
      const contentError = toObservationError(error);
      await endAgentRunSpanIfOpen({
        prepared,
        started: true,
        completed: agentSpanCompleted,
        status: "error",
        latencyMs: Date.now() - chatStartedAt,
        errorCode: contentError.code,
        errorMessage: contentError.message,
      });
      agentSpanCompleted = true;
      traceEnded =
        (await endThreadTraceIfOpen({
          prepared,
          ended: traceEnded,
          operation: "chat.complete",
          status: "error",
          latencyMs: Date.now() - chatStartedAt,
          outcome,
          errorCode: contentError.code,
          errorMessage: contentError.message,
        })) || traceEnded;
      throw error;
    }
  }
}

export { ContentThreadStreamService };
