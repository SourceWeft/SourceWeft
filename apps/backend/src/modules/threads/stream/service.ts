import type { MeterConsumeResponse } from "@sourceweft/contracts";
import {
  invokeDeepAgentTurn,
  type DeepAgentTurnOutcome,
} from "../agent/turn/runner";
import { createRunCancellationGate } from "../run-cancellation";
import { agentSandboxService } from "../agent/sandbox-service/service";
import type { AgentCitation } from "../agent/citation-registry";
import type {
  EmbeddingVectorStrategy,
  MessageRecord,
} from "../../content/types";
import type { ContentBillingPort } from "../../content/billing-port";
import { ContentError } from "../../content/errors";
import { sanitizeClientErrorMessage } from "../../content/model-gateway-error";
import { logger } from "../../../shared/logger";
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
import { findAgentToolTerminationUnknownReason } from "../agent/middleware/tool-execution-timeout";
import {
  buildAgentRunSpanMetadata,
  buildAgentRunSpanOutput,
  buildFinalizeSpanInput,
  buildPrepareSpanInput,
  buildPrepareSpanOutput,
  buildThreadTraceContext,
  endAgentRunSpanIfOpen,
  endThreadTraceIfOpen,
  observePrepareFailure,
  startThreadTrace,
  threadStreamObservability,
  toObservationError,
  withObservedSpan,
} from "./observability";
import {
  appendReasoningChunk,
  buildPartialErrorState,
  buildTerminalTraceState,
  getThinkingStepStreamKey,
  resolveToolConfirmationFinishPayload,
  upsertReasoningSegmentTrace,
  upsertThinkingStepTrace,
  upsertToolCallTrace,
} from "./run-trace-state";
import {
  createPreflightThinkingStepQueue,
  waitForPrepareOrPreflightStep,
} from "./preflight-steps";
import {
  enqueueAutomaticThreadTitleJob,
  shouldGenerateAutomaticThreadTitle,
  titleCompletionToUpdate,
  waitForThreadTitleJob,
  type ThreadTitleJobCompletion,
} from "./title-updates";

// Part of this module's public surface since before the T2.3 split; the
// implementations now live in ./observability.
export {
  buildAgentRunSpanMetadata,
  buildAgentRunSpanOutput,
  threadStreamObservability,
} from "./observability";

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

function isClientCancelledError(error: ContentError) {
  return error.code === "CLIENT_CANCELLED";
}

async function throwIfClientCancelled(
  shouldCancel: ThreadStreamRunOptions["shouldCancel"],
  abortSignal?: AbortSignal,
) {
  if (abortSignal?.aborted && abortSignal.reason instanceof ContentError) {
    throw abortSignal.reason;
  }
  if (abortSignal?.aborted || (await shouldCancel?.())) {
    throw new ContentError(499, "CLIENT_CANCELLED", "Chat run was cancelled");
  }
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

  async refreshThread(
    input: RefreshThreadInput,
    options?: ThreadStreamRunOptions,
  ) {
    return this.streamThread(
      await resolveRefreshThreadStreamInput(input),
      options,
    );
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

  async resumeThread(
    input: ResumeThreadInput,
    options?: ThreadStreamRunOptions,
  ) {
    return this.streamThread(
      await resolveResumeThreadStreamInput(input),
      options,
    );
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

  async editThread(input: EditThreadInput, options?: ThreadStreamRunOptions) {
    return this.streamThread(
      await resolveEditThreadStreamInput(input),
      options,
    );
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
    // Set when the catch path handled a client cancel: the finally must still
    // release the sandbox lease even though the trace was already ended there.
    let clientCancelledTeardown = false;
    // Held for the finally so an unwind can close the agent iterator even
    // though it is created inside the inner try.
    let activeAgentEvents: ReturnType<typeof invokeDeepAgentTurn> | null = null;
    // One predicate for "did this turn stream anything worth keeping" — the
    // cancel paths (catch and abandoned-stream finally) must agree on it.
    const hasSubstantivePartialTurn = () =>
      assistantContent.trimEnd().length > 0 ||
      toolCallsById.size > 0 ||
      thinkingStepsById.size > 0 ||
      reasoningSegmentsById.size > 0 ||
      citations.length > 0;
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
        activeAgentEvents = agentEvents;
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
        // A pull issued here can still be pending when this generator unwinds —
        // a cancel-checkpoint throw, an event-processing error, or the SSE
        // consumer tearing down mid-yield. Observe every pull the moment it is
        // issued so the aborted agent stream's rejection can never surface as
        // an unhandled rejection and kill the process; raceNext stays the real
        // consumer and still sees the rejection.
        const pullAgentEvent = () => {
          const pull = agentEvents.next();
          pull.catch(() => {});
          return pull;
        };
        let nextAgentEvent = pullAgentEvent();
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
        // Same unhandled-rejection guard for a title job that fails after the
        // loop stopped racing it.
        titleCompletion?.catch(() => {});

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
            if (!findAgentToolTerminationUnknownReason(error)) {
              await throwIfClientCancelled(
                options.shouldCancel,
                options.abortSignal,
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

          nextAgentEvent = pullAgentEvent();
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
        if (isClientCancelled) {
          clientCancelledTeardown = true;
        }

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
        // A cancel with nothing substantive streamed persists no turn — the
        // same gate the abandoned-stream finally applies — so a disconnect or
        // Stop does not leave an empty "cancelled" assistant message behind.
        // Real errors keep persisting unconditionally.
        const errorMessage =
          !isClientCancelled || hasSubstantivePartialTurn()
            ? await createErrorMessage({
                prepared,
                contentError,
                partialAssistantContent: assistantContent,
                partialState: buildPartialErrorState({
                  ...(isClientCancelled
                    ? { errorMessage: contentError.message }
                    : {}),
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
              })
            : null;
        persistedErrorMessage = Boolean(errorMessage);
        if (
          !errorMessage &&
          // A cancel never unwinds the user's own message: they sent it and
          // then stopped the answer — matching the abandoned-stream path,
          // which has never rolled back on disconnect.
          !isClientCancelled &&
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
      // Close the agent iterator so its own finally (MCP teardown, sandbox
      // operation cleanup) runs even when this generator unwinds first.
      // Fire-and-forget: teardown must not block on a stuck inner await, and
      // every pending pull is already rejection-observed.
      void activeAgentEvents?.return(undefined).catch(() => {});
      const streamAbandoned = !traceEnded;
      if (streamAbandoned) {
        const contentError = new ContentError(
          499,
          "CLIENT_CANCELLED",
          "Client closed the stream before completion",
        );
        if (
          !persistedErrorMessage &&
          !responseFinished &&
          hasSubstantivePartialTurn()
        ) {
          const createErrorMessage =
            options.createErrorMessage ?? this.createErrorMessage;
          const errorMessage = await createErrorMessage({
            prepared,
            contentError,
            partialAssistantContent: assistantContent,
            partialState: buildPartialErrorState({
              errorMessage: contentError.message,
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
      }
      // Released for BOTH cancel shapes: the abandoned stream (finally is the
      // only unwind) and the catch-handled client cancel (which already ended
      // the trace, so the block above is skipped). Before this, a cancel that
      // took the catch path held its sandbox for the full TTL.
      if (streamAbandoned || clientCancelledTeardown) {
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
            reason: streamAbandoned ? "stream_abandoned" : "client_cancelled",
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

  async streamThread(
    input: StreamThreadEventInput,
    options: ThreadStreamRunOptions = {},
  ) {
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
          abortSignal: options.abortSignal,
          runCancellation: createRunCancellationGate({
            shouldCancel: options.shouldCancel,
            signal: options.abortSignal,
          }),
        })) {
          // The non-streaming door gets the same cancel checkpoints as the SSE
          // one: without them a client disconnect or Stop ran the whole turn
          // to completion and billed it.
          await throwIfClientCancelled(
            options.shouldCancel,
            options.abortSignal,
          );
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
        // Cancel mirrors the SSE door: no failure record, no persisted turn,
        // no user-message rollback — the trace just ends as cancelled.
        const isClientCancelled = isClientCancelledError(contentError);
        if (!isClientCancelled) {
          await recordThreadStreamFailure({
            prepared,
            contentError,
            operation: "chat.complete",
            llm: prepared.llm,
          });
        }
        const errorMessage = isClientCancelled
          ? null
          : await this.createErrorMessage({
              prepared,
              contentError,
              partialState: {
                thinkingSteps: prepared.preflightThinkingSteps,
                meteredLlmCalls: meteredLlmCallsOnFailure(),
              },
            });
        if (
          !errorMessage &&
          !isClientCancelled &&
          prepared.failurePersistence === "persist-error-turn"
        ) {
          await rollbackCreatedUserMessage({ prepared });
        }
        await endAgentRunSpanIfOpen({
          prepared,
          started: true,
          completed: agentSpanCompleted,
          status: isClientCancelled ? "cancelled" : "error",
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
            status: isClientCancelled ? "cancelled" : "error",
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
