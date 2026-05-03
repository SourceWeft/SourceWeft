import type { Job } from "bullmq";
import { getJobsQueueEvents } from "../../../../shared/queue";
import { invokeDeepAgentTurn, type DeepAgentTurnOutcome } from "../../agent/turn/runner";
import { ContentError } from "../../errors";
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

type ThreadTitleJob = Job<Record<string, unknown>, unknown, string>;

type ThreadTitleJobCompletion = {
  jobId: string;
  result: ThreadTitleGenerateJobResult | null;
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
    sourceCount: input.prepared.sourceIds.length,
  };
}

export function buildAgentRunSpanMetadata(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return {
    mode: prepared.agentMode,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
    gateway: buildGatewayAuditMetadata({ llm: prepared.llm }),
  };
}

function buildTraceInput(
  prepared: Awaited<ReturnType<ContentThreadTurnService["prepareThreadTurn"]>>,
) {
  return {
    message: prepared.messageContent,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
    sourceIds: prepared.sourceIds,
    threadId: prepared.thread.id,
    userMessageId: prepared.userMessage.id,
  };
}

function buildTraceOutput(outcome: DeepAgentTurnOutcome) {
  return {
    content: outcome.assistantContent,
    finishReason: outcome.finishReason,
    usage: outcome.usage,
    reasoning: outcome.reasoning,
    toolCalls: outcome.toolCalls,
    retrievalCalls: outcome.retrievalCalls,
    citationCount: outcome.citations.length,
  };
}

export function buildAgentRunSpanOutput(outcome: DeepAgentTurnOutcome) {
  return {
    assistantContent: outcome.assistantContent,
    finishReason: outcome.finishReason,
    usage: outcome.usage,
    reasoning: outcome.reasoning,
    toolCallCount: outcome.toolCalls.length,
    retrievalCallCount: outcome.retrievalCalls.length,
    citationCount: outcome.citations.length,
    availableCitationCount: outcome.availableCitations.length,
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
    sourceIds: prepared.sourceIds,
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
    sourceCount: prepared.sourceIds.length,
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
    citationCount: input.outcome.citations.length,
    availableCitationCount: input.outcome.availableCitations.length,
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
  await startTrace({
    ...input.trace,
    name: "thread.stream",
    feature: "chat",
    sessionId: input.trace.sessionId,
    input: buildTraceInput(input.prepared),
    metadata: buildTraceMetadata(input),
  });
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
  await startSpan({
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
    await endSpan({
      traceId: input.trace.traceId,
      spanId: input.spanId,
      status: "ok",
      latencyMs: Date.now() - startedAt,
      output: input.output?.(output),
    });
    return output;
  } catch (error) {
    await endSpan({
      traceId: input.trace.traceId,
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
    result.status === "applied" ||
    result.status === "skipped"
  ) && typeof result.threadId === "string";
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
    const result = await input.job.waitUntilFinished(getJobsQueueEvents());
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

  async *refreshThreadEvents(input: RefreshThreadInput): AsyncGenerator<string> {
    yield* this.streamThreadEvents(await resolveRefreshThreadStreamInput(input));
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
    const prepared = await this.turnService.prepareThreadTurn(input);
    const prepareEndedAt = new Date();
    prepared.traceContext = buildThreadTraceContext(prepared);
    await startThreadTrace({
      trace: prepared.traceContext,
      prepared,
      operation: "chat.stream",
    });
    const chatStartedAt = Date.now();
    await startSpan({
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
    await endSpan({
      traceId: prepared.traceContext.traceId,
      spanId: "prepare_thread_turn",
      status: "ok",
      endedAt: prepareEndedAt,
      latencyMs: prepareEndedAt.getTime() - prepareStartedAt.getTime(),
      output: buildPrepareSpanOutput(prepared),
    });

    const textId = `text-${prepared.userMessage.id}`;
    yield toSseData({ type: "start", messageId: prepared.userMessage.id });
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

    let traceEnded = false;
    let agentSpanCompleted = false;
    let outcome: DeepAgentTurnOutcome | null = null;
    try {
      const agentEvents = this.invokeAgentTurn({
        prepared,
        llm: prepared.llm,
        traceContext: {
          ...prepared.traceContext,
          parentSpanId: "agent_run",
        },
      });
      await startSpan({
        ...prepared.traceContext,
        spanId: "agent_run",
        name: "agent_run",
        kind: "agent",
        operation: "agent.run",
        input: {
          message: prepared.messageContent,
          modelAlias: prepared.modelAlias,
          profileAlias: prepared.profileAlias,
          sourceCount: prepared.sourceIds.length,
        },
        metadata: {
          ...buildAgentRunSpanMetadata(prepared),
        },
      });
      let nextAgentEvent = agentEvents.next();
      let titleSettled = false;
      let titleResolvedCompletion: ThreadTitleJobCompletion | null = null;
      const titleCompletion: Promise<ThreadTitleJobCompletion> | null = titleJob
        ? waitForThreadTitleJob({ job: titleJob, prepared }).then((completion) => {
            titleSettled = true;
            titleResolvedCompletion = completion;
            return completion;
          })
        : null;
      let nextTitleEvent: Promise<ThreadTitleJobCompletion> | null = titleCompletion;

      while (true) {
        const result = await Promise.race([
          nextAgentEvent.then((value) => ({ type: "agent" as const, value })),
          ...(nextTitleEvent ? [nextTitleEvent.then((value) => ({ type: "title" as const, value }))] : []),
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

      await endSpan({
        traceId: prepared.traceContext.traceId,
        spanId: "agent_run",
        status: "ok",
        latencyMs: Date.now() - chatStartedAt,
        output: buildAgentRunSpanOutput(completedOutcome),
      });
      agentSpanCompleted = true;

      const { assistantMessage } =
        await withObservedSpan({
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
          execute: () => this.turnService.finalizeThreadTurn({
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
      const contentError =
        error instanceof ContentError ? error : toContentServiceError(error);

      await recordThreadStreamFailure({
        prepared,
        contentError,
        operation: "chat.stream",
        llm: prepared.llm,
      });
      const errorMessage = await this.createErrorMessage({
        prepared,
        contentError,
      });
      if (!errorMessage) {
        await rollbackCreatedUserMessage({ prepared });
      }
      if (!agentSpanCompleted) {
        await endSpan({
          traceId: prepared.traceContext.traceId,
          spanId: "agent_run",
          status: "error",
          latencyMs: Date.now() - chatStartedAt,
          errorCode: contentError.code,
          errorMessage: contentError.message,
        });
      }
      await endTrace({
        traceId: prepared.traceContext.traceId,
        status: "error",
        latencyMs: Date.now() - chatStartedAt,
        errorCode: contentError.code,
        errorMessage: contentError.message,
        metadata: buildTraceMetadata({
          prepared,
          operation: "chat.stream",
        }),
      });
      traceEnded = true;

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
      await endTrace({
        traceId: prepared.traceContext.traceId,
        status: "ok",
        latencyMs: Date.now() - chatStartedAt,
        output: outcome ? buildTraceOutput(outcome) : undefined,
        metadata: buildTraceMetadata({
          prepared,
          operation: "chat.stream",
        }),
      });
    }

    yield toSseData({ type: "finish" });
  }

  async streamThread(input: StreamThreadEventInput) {
    const prepareStartedAt = new Date();
    const prepared = await this.turnService.prepareThreadTurn(input);
    const prepareEndedAt = new Date();
    prepared.traceContext = buildThreadTraceContext(prepared);
    await startThreadTrace({
      trace: prepared.traceContext,
      prepared,
      operation: "chat.complete",
    });
    const chatStartedAt = Date.now();
    await startSpan({
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
    await endSpan({
      traceId: prepared.traceContext.traceId,
      spanId: "prepare_thread_turn",
      status: "ok",
      endedAt: prepareEndedAt,
      latencyMs: prepareEndedAt.getTime() - prepareStartedAt.getTime(),
      output: buildPrepareSpanOutput(prepared),
    });
    await startSpan({
      ...prepared.traceContext,
      spanId: "agent_run",
      name: "agent_run",
      kind: "agent",
      operation: "agent.run",
      input: {
        message: prepared.messageContent,
        modelAlias: prepared.modelAlias,
        profileAlias: prepared.profileAlias,
        sourceCount: prepared.sourceIds.length,
      },
      metadata: {
        ...buildAgentRunSpanMetadata(prepared),
      },
    });
    let agentSpanCompleted = false;
    let traceEnded = false;

    const outcome = await (async () => {
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
      const contentError =
        error instanceof ContentError ? error : toContentServiceError(error);
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
      if (!errorMessage) {
        await rollbackCreatedUserMessage({ prepared });
      }
      if (!agentSpanCompleted) {
        await endSpan({
          traceId: prepared.traceContext!.traceId,
          spanId: "agent_run",
          status: "error",
          latencyMs: Date.now() - chatStartedAt,
          errorCode: contentError.code,
          errorMessage: contentError.message,
        });
      }
      await endTrace({
        traceId: prepared.traceContext!.traceId,
        status: "error",
        latencyMs: Date.now() - chatStartedAt,
        errorCode: contentError.code,
        errorMessage: contentError.message,
        metadata: buildTraceMetadata({
          prepared,
          operation: "chat.complete",
        }),
      });
      traceEnded = true;
      throw contentError;
    });

    await endSpan({
      traceId: prepared.traceContext.traceId,
      spanId: "agent_run",
      status: "ok",
      latencyMs: Date.now() - chatStartedAt,
      output: buildAgentRunSpanOutput(outcome),
    });
    agentSpanCompleted = true;

    const { assistantMessage, billing } =
      await withObservedSpan({
        trace: prepared.traceContext,
        spanId: "finalize_thread_turn",
        name: "finalize_thread_turn",
        kind: "system",
        operation: "thread.finalize",
        input: buildFinalizeSpanInput({
          prepared,
          outcome,
          operation: "chat.complete",
          latencyMs: Date.now() - chatStartedAt,
        }),
        output: (result) => ({
          assistantMessageId: result.assistantMessage.id,
          parentMessageId: result.assistantMessage.parentMessageId,
          contentLength: outcome.assistantContent.length,
          citationCount: outcome.citations.length,
          availableCitationCount: outcome.availableCitations.length,
          toolCallCount: outcome.toolCalls.length,
          retrievalCallCount: outcome.retrievalCalls.length,
          saved: true,
        }),
        execute: () => this.turnService.finalizeThreadTurn({
          prepared,
          retrieval: outcome.retrieval,
          citations: outcome.citations,
          availableCitations: outcome.availableCitations,
          retrievalCalls: outcome.retrievalCalls,
          toolCalls: outcome.toolCalls,
          thinkingSteps: outcome.thinkingSteps,
          reasoningSegments: outcome.reasoningSegments,
          llm: prepared.llm,
          operation: "chat.complete",
          assistantContent: outcome.assistantContent,
          usage: outcome.usage,
          finishReason: outcome.finishReason,
          reasoning: outcome.reasoning,
          agentCheckpoint: outcome.agentCheckpoint,
          latencyMs: Date.now() - chatStartedAt,
          modelForMessage: prepared.modelAlias,
        }),
      });

    const titleJob = await this.enqueueTitleJob({ prepared });
    if (titleJob) {
      await waitForThreadTitleJob({ job: titleJob, prepared });
    }

    if (!traceEnded) {
      await endTrace({
        traceId: prepared.traceContext.traceId,
        status: "ok",
        latencyMs: Date.now() - chatStartedAt,
        output: buildTraceOutput(outcome),
        metadata: buildTraceMetadata({
          prepared,
          operation: "chat.complete",
        }),
      });
    }

    return {
      thread: prepared.thread,
      userMessage: prepared.userMessage,
      assistantMessage,
      billing,
      retrieval: {
        embeddingProfileId: outcome.retrieval?.profile.id ?? null,
        vectorStrategy: outcome.retrieval?.planner.strategy ?? null,
        annIndexUsed: outcome.retrieval?.planner.annIndexUsed ?? null,
        citations: outcome.citations,
        availableCitations: outcome.availableCitations,
      },
    };
  }
}

export { ContentThreadStreamService };
