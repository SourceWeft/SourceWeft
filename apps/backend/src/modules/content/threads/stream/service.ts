import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { getJobsQueueEvents } from "../../../../shared/queue";
import {
  invokeDeepAgentTurn,
  type DeepAgentTurnOutcome,
} from "../../agent/turn/runner";
import type { AgentCitation } from "../../agent/citation-registry";
import { ContentError } from "../../errors";
import { requireContentWorkspace } from "../../content-support";
import { toContentServiceError } from "../../model-gateway-error";
import { logger } from "../../../../shared/logger";
import { buildGatewayAuditMetadata } from "../../model-gateway-audit";
import {
  endSpan,
  endTrace,
  startSpan,
  startTrace,
  type TraceContext,
} from "../../../../shared/llm-observability";
import {
  type ContentThreadTurnService,
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
} from "./input";
import type { EditThreadInput, RefreshThreadInput } from "./types";
import type {
  ThreadTitleGenerateJobPayload,
  ThreadTitleGenerateJobResult,
} from "../../queue";
import type {
  ModelReasoningSegmentTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../turn/types";

type ThreadTitleJob = Job<Record<string, unknown>, unknown, string>;

type ThreadTitleJobCompletion = {
  jobId: string;
  result: ThreadTitleGenerateJobResult | null;
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
  return {
    operation: input.operation,
    modelAlias: input.prepared.modelAlias,
    profileAlias: input.prepared.profileAlias,
    agentMode: input.prepared.agentMode,
    sourceCount: input.prepared.selectedSourceIds.length,
    effectiveSourceCount: input.prepared.sourceIds.length,
    mentionedSourceCount: input.prepared.mentionedSourceIds.length,
    effectiveMentionedSourceCount:
      input.prepared.effectiveMentionedSourceIds.length,
    selectedSkillCount: input.prepared.enabledSkills.length,
  };
}

function toObservationError(error: unknown) {
  return error instanceof ContentError ? error : toContentServiceError(error);
}

export function buildAgentRunSpanMetadata(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return {
    mode: prepared.agentMode,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
    gateway: buildGatewayAuditMetadata({ llm: prepared.llm }),
    selectedSkillCount: prepared.enabledSkills.length,
  };
}

function buildTraceInput(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return {
    message: prepared.messageContent,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
    sourceIds: prepared.selectedSourceIds,
    effectiveSourceIds: prepared.sourceIds,
    mentionedSourceIds: prepared.mentionedSourceIds,
    effectiveMentionedSourceIds: prepared.effectiveMentionedSourceIds,
    skillIds: prepared.skillIds,
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

function normalizeToolCallStatusForError(
  toolCall: ToolCallTrace,
): ToolCallTrace {
  return toolCall.status === "running"
    ? {
        ...toolCall,
        status: "error",
        error: toolCall.error ?? "Tool execution failed.",
      }
    : toolCall;
}

function normalizeThinkingStepStatusForError(
  step: ThinkingStepTrace,
): ThinkingStepTrace {
  return step.status === "in_progress"
    ? {
        ...step,
        status: "completed",
      }
    : step;
}

function upsertToolCallTrace(
  callsById: Map<string, ToolCallTrace>,
  toolCall: ToolCallTrace,
) {
  callsById.set(toolCall.id, toolCall);
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
    citationCount: outcome.citations.length,
    availableCitationCount: outcome.availableCitations.length,
    citations: buildCitationObservations(outcome.citations),
    availableCitations: buildCitationObservations(outcome.availableCitations),
  };
}

function buildPartialErrorState(input: {
  reasoning?: string;
  reasoningSegmentsById: Map<string, ModelReasoningSegmentTrace>;
  toolCallsById: Map<string, ToolCallTrace>;
  thinkingStepsById: Map<string, ThinkingStepTrace>;
  citations: AgentCitation[];
  availableCitations: AgentCitation[];
}): ThreadStreamPartialErrorState {
  return {
    reasoning: input.reasoning,
    reasoningSegments: [...input.reasoningSegmentsById.values()],
    toolCalls: [...input.toolCallsById.values()].map(
      normalizeToolCallStatusForError,
    ),
    thinkingSteps: [...input.thinkingStepsById.values()].map(
      normalizeThinkingStepStatusForError,
    ),
    citations: input.citations,
    availableCitations: input.availableCitations,
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
    skillIds: prepared.skillIds,
  };
}

function buildPrepareSpanOutput(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return {
    createdUserMessage: prepared.createdUserMessage,
    agentMode: prepared.agentMode,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
    sourceCount: prepared.selectedSourceIds.length,
    effectiveSourceCount: prepared.sourceIds.length,
    mentionedSourceCount: prepared.mentionedSourceIds.length,
    effectiveMentionedSourceCount: prepared.effectiveMentionedSourceIds.length,
    selectedSkillCount: prepared.enabledSkills.length,
    isFirstAssistantResponse: prepared.isFirstAssistantResponse,
    assistantMessageParentId: prepared.assistantMessageParentId,
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
  status: "error" | "cancelled";
  latencyMs: number;
  errorCode?: string | null;
  errorMessage?: string | null;
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
    metadata: buildTraceMetadata({
      prepared: input.prepared,
      operation: input.operation,
    }),
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
  return prepared.isFirstAssistantResponse;
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

  const { enqueueThreadTitleGenerateJob } = await import("../../queue");
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
    gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
    expectedTitle: input.prepared.initialTitle,
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
  constructor(
    private readonly turnService: ContentThreadTurnService,
    private readonly invokeAgentTurn = invokeDeepAgentTurn,
    private readonly enqueueTitleJob = enqueueAutomaticThreadTitleJob,
    private readonly createErrorMessage = createThreadStreamErrorMessage,
  ) {}

  async refreshThread(input: RefreshThreadInput) {
    return this.streamThread(await resolveRefreshThreadStreamInput(input));
  }

  async *refreshThreadEvents(
    input: RefreshThreadInput,
  ): AsyncGenerator<string> {
    yield* this.streamThreadEvents(
      await resolveRefreshThreadStreamInput(input),
    );
  }

  async editThread(input: EditThreadInput) {
    return this.streamThread(await resolveEditThreadStreamInput(input));
  }

  async *editThreadEvents(input: EditThreadInput): AsyncGenerator<string> {
    yield* this.streamThreadEvents(await resolveEditThreadStreamInput(input));
  }

  async *streamThreadEvents(
    input: StreamThreadEventInput,
  ): AsyncGenerator<string> {
    const prepareStartedAt = new Date();
    const prepared = await this.turnService
      .prepareThreadTurn(input)
      .catch(async (error: unknown) => {
        await observePrepareFailure({
          request: input,
          operation: "chat.stream",
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
        profileAlias: prepared.profileAlias,
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
    const toolCallsById = new Map<string, ToolCallTrace>();
    const thinkingStepsById = new Map<string, ThinkingStepTrace>();
    let citations: AgentCitation[] = [];
    let availableCitations: AgentCitation[] = [];
    let responseFinished = false;
    let persistedErrorMessage = false;
    try {
      yield toSseData({
        type: "start",
        messageId: prepared.userMessage.id,
        mentionedSourceIds: prepared.mentionedSourceIds,
        effectiveMentionedSourceIds: prepared.effectiveMentionedSourceIds,
        sourceIds: prepared.selectedSourceIds,
        effectiveSourceIds: prepared.sourceIds,
      });
      yield toSseData({ type: "text-start", id: textId });

      const titleUpdates: Array<{ id: string; title: string }> = [];
      let titleUpdateEmitted = false;
      const titleJob = await this.enqueueTitleJob({ prepared });
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
          llm: prepared.llm,
          traceContext: {
            ...prepared.traceContext,
            parentSpanId: "agent_run",
          },
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
            profileAlias: prepared.profileAlias,
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
          const result = await Promise.race([
            nextAgentEvent.then((value) => ({ type: "agent" as const, value })),
            ...(nextTitleEvent
              ? [
                  nextTitleEvent.then((value) => ({
                    type: "title" as const,
                    value,
                  })),
                ]
              : []),
          ]);

          if (result.type === "title") {
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
          if (event.type === "done") {
            outcome = event.outcome;
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
            reasoningSegmentsById.set(event.segment.id, event.segment);
          }
          if (
            event.type === "tool-call-start" ||
            event.type === "tool-call-event" ||
            event.type === "tool-call-result" ||
            event.type === "tool-call-error" ||
            event.type === "tool-call-end"
          ) {
            upsertToolCallTrace(toolCallsById, event.toolCall);
          }
          if (event.type === "thinking-step") {
            upsertThinkingStepTrace(thinkingStepsById, event.step);
          }
          if (event.type === "citations") {
            citations = event.citations;
            availableCitations = event.availableCitations ?? event.citations;
          }

          yield mapDeepAgentEventToSse(event, textId);
          yield* emitTitleUpdates();
        }

        if (!outcome) {
          throw new ContentError(
            502,
            "MODEL_EMPTY_RESPONSE",
            "Model returned no response",
          );
        }
        const completedOutcome = outcome;

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

        const { assistantMessage } = await withObservedSpan({
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
              thinkingSteps: completedOutcome.thinkingSteps,
              reasoningSegments: completedOutcome.reasoningSegments,
              llm: prepared.llm,
              operation: "chat.stream",
              assistantContent: completedOutcome.assistantContent,
              usage: completedOutcome.usage,
              finishReason: completedOutcome.finishReason,
              reasoning: completedOutcome.reasoning,
              agentCheckpoint: completedOutcome.agentCheckpoint,
              latencyMs: Date.now() - chatStartedAt,
            }),
        });

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

        await recordThreadStreamFailure({
          prepared,
          contentError,
          operation: "chat.stream",
          llm: prepared.llm,
        });
        const errorMessage = await this.createErrorMessage({
          prepared,
          contentError,
          partialAssistantContent: assistantContent,
          partialState: buildPartialErrorState({
            reasoning,
            reasoningSegmentsById,
            toolCallsById,
            thinkingStepsById,
            citations,
            availableCitations,
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
          status: "error",
          latencyMs: Date.now() - chatStartedAt,
          errorCode: contentError.code,
          errorMessage: contentError.message,
        });
        agentSpanCompleted = agentSpanCompleted || agentSpanStarted;
        traceEnded =
          (await endThreadTraceIfOpen({
            prepared,
            ended: traceEnded,
            operation: "chat.stream",
            status: "error",
            latencyMs: Date.now() - chatStartedAt,
            errorCode: contentError.code,
            errorMessage: contentError.message,
          })) || traceEnded;

        yield toSseData({ type: "text-end", id: textId });

        yield toSseData({
          type: "error",
          code: contentError.code,
          error: contentError.message,
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
      yield toSseData({ type: "finish" });
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
          const errorMessage = await this.createErrorMessage({
            prepared,
            contentError,
            partialAssistantContent: assistantContent,
            partialState: buildPartialErrorState({
              reasoning,
              reasoningSegmentsById,
              toolCallsById,
              thinkingStepsById,
              citations,
              availableCitations,
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
          })) || traceEnded;
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
        profileAlias: prepared.profileAlias,
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
        profileAlias: prepared.profileAlias,
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

    try {
      outcome = await (async () => {
        let doneOutcome: DeepAgentTurnOutcome | null = null;
        for await (const event of this.invokeAgentTurn({
          prepared,
          llm: prepared.llm,
          traceContext: {
            ...prepared.traceContext!,
            parentSpanId: "agent_run",
          },
        })) {
          if (event.type === "done") {
            doneOutcome = event.outcome;
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
            thinkingSteps: completedOutcome.thinkingSteps,
            reasoningSegments: completedOutcome.reasoningSegments,
            llm: prepared.llm,
            operation: "chat.complete",
            assistantContent: completedOutcome.assistantContent,
            usage: completedOutcome.usage,
            finishReason: completedOutcome.finishReason,
            reasoning: completedOutcome.reasoning,
            agentCheckpoint: completedOutcome.agentCheckpoint,
            latencyMs: Date.now() - chatStartedAt,
            modelForMessage: prepared.modelAlias,
          }),
      });

      const titleJob = await this.enqueueTitleJob({ prepared });
      if (titleJob) {
        await waitForThreadTitleJob({ job: titleJob, prepared });
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
