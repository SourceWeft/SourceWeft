import type { AgentRunStop, AgentRunProgress } from "@sourceweft/contracts";
import { AgentCitationRegistry } from "../citation-registry";
import type {
  PreparedThreadTurn,
  RetrievalCallTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../..";
import {
  createMessageRenderBlockBuilder,
  type MessageRenderBlockMark,
} from "../../turn/render-blocks";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { createCitationSnapshotTracker } from "./citation-tracker";
import type { DeepAgentTurnOutcome } from "./events";
import { runToolRetrieval } from "./retrieval-runner";
import {
  appendReasoningChunk,
  createModelReasoningSegmentId,
  upsertThinkingStep,
} from "./thinking";
import {
  createTraceSequenceAllocator,
  type PendingToolStream,
  type ObservedAgentToolCall,
} from "./tool-tracker";
import type { BillingScope } from "../../../../shared/model-gateway/index";

type ToolRetrieval = Awaited<ReturnType<typeof runToolRetrieval>>;
type RetrievalCitation = ReturnType<
  AgentCitationRegistry["addRetrievalCandidate"]
>;

export type TurnRuntime = ReturnType<typeof createTurnRuntime>;

/**
 * What the runtime held when a model-call attempt began. A retry of that call
 * rolls the runtime back to it (`discardModelOutputSince`) so the failed
 * attempt's partial stream is withdrawn instead of replayed on top of itself.
 * Strings are kept by reference (immutable, so no copy); the event the client
 * receives carries their lengths.
 */
export type ModelCallBoundary = {
  attempt: number;
  assistantContent: string;
  modelReasoning: string | undefined;
  hasStreamedText: boolean;
  hasTextSinceLastToolBoundary: boolean;
  suppressRawToolCallText: boolean;
  suppressLeakedCommandSpecText: boolean;
  finishReason: string | undefined;
  providerFields: Record<string, unknown> | undefined;
  /**
   * Reasoning segments that existed before the attempt started. The caller
   * closes any open segment before capturing, so every segment the attempt
   * streams is a new one and `segmentIds` fully describes a withdrawal.
   */
  segmentCount: number;
  renderBlocks: MessageRenderBlockMark;
  /** Streamed tool-arg buffers by slot, with the args length each had. */
  toolArgSlots: Map<string, number>;
};

export function createTurnRuntime(input: { prepared: PreparedThreadTurn }) {
  const retrievalCallsById = new Map<string, RetrievalCallTrace>();
  const retrievalsByToolCallId = new Map<string, ToolRetrieval>();
  const retrievalCallOrder: string[] = [];
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];
  const toolStartedAtById = new Map<string, number>();
  const pendingToolStreamsByRunId = new Map<string, PendingToolStream>();
  const observedToolCallsById = new Map<string, ObservedAgentToolCall>();
  // Per-tool-call-slot accumulator for streamed partial tool-call args (used to
  // surface incremental write_file `content` before the tool call is complete).
  const partialToolArgsBySlot = new Map<
    string,
    import("./tool-arg-stream-handler").PartialToolArgStreamState
  >();
  const thinkingStepsById = new Map<string, ThinkingStepTrace>();
  const thinkingStepOrder: string[] = [];
  const reasoningSegments: DeepAgentTurnOutcome["reasoningSegments"] = [];
  // A resumed turn continues the blocks its message already shows.
  const renderBlocks = createMessageRenderBlockBuilder(
    input.prepared.traceContinuation?.renderBlocks,
  );
  const runStartedAt = Date.now();
  let currentReasoningSegmentStartedAt: number | null = null;
  // Segment ids are never reused: a segment withdrawn by a model-call retry
  // keeps its index so the retried attempt's segment gets a fresh id (the
  // client drops the old id on `segment-reset`).
  let nextReasoningSegmentIndex = 1;
  const citationRegistry = new AgentCitationRegistry({
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
  });
  // A resumed turn continues its message's registry, so ids cited before the
  // pause keep resolving and new evidence is numbered after them.
  citationRegistry.restore(input.prepared.traceContinuation?.citations ?? []);
  const traceSequenceAllocator = createTraceSequenceAllocator({
    traceContinuation: input.prepared.traceContinuation,
  });
  const getNewCitationSnapshot = createCitationSnapshotTracker({
    citationRegistry,
  });
  const { nextSequence, resolveToolCallSequence } = traceSequenceAllocator;

  const runtime = {
    retrievalCallsById,
    retrievalsByToolCallId,
    retrievalCallOrder,
    toolCallsById,
    mcpDisplayByToolName: new Map<
      string,
      NonNullable<ToolCallTrace["mcpDisplay"]>
    >(),
    toolCallOrder,
    toolStartedAtById,
    pendingToolStreamsByRunId,
    partialToolArgsBySlot,
    observedToolCallsById,
    thinkingStepsById,
    thinkingStepOrder,
    reasoningSegments,
    renderBlocks,
    runStartedAt,
    citationRegistry,
    getNewCitationSnapshot,
    nextSequence,
    resolveToolCallSequence,
    latestToolRetrieval: null as ToolRetrieval | null,
    assistantContent: "",
    assistantContentFromUpdates: null as string | null,
    finishReason: undefined as string | undefined,
    agentRunStop: undefined as AgentRunStop | undefined,
    agentRunProgress: undefined as AgentRunProgress | undefined,
    stepLimitSummary: null as string | null,
    modelReasoning: undefined as string | undefined,
    providerFields: undefined as Record<string, unknown> | undefined,
    hasStreamedText: false,
    hasTextSinceLastToolBoundary: false,
    /**
     * The turn's billing scope: the single source of what this turn metered.
     *
     * Assigned once the turn's model is built. It outlives this generator, so
     * a turn that crashes partway through still carries its settled calls.
     */
    billingScope: null as BillingScope | null,
    suppressRawToolCallText: false,
    suppressLeakedCommandSpecText: false,
    currentReasoningSegment: null as
      DeepAgentTurnOutcome["reasoningSegments"][number] | null,
    /** Set by `model-call-begin`; consumed by `model-call-retry`. */
    modelCallBoundary: null as ModelCallBoundary | null,
    nextReasoningContext: { phase: "initial" } as
      | { phase: "initial" }
      | { phase: "after_tool"; toolCallId: string; tool: string },
    resetReasoningBoundary() {
      runtime.currentReasoningSegment = null;
      currentReasoningSegmentStartedAt = null;
    },
    /** Snapshot the model-output state as a model-call attempt begins. */
    captureModelCallBoundary(attempt: number): ModelCallBoundary {
      return {
        attempt,
        assistantContent: runtime.assistantContent,
        modelReasoning: runtime.modelReasoning,
        hasStreamedText: runtime.hasStreamedText,
        hasTextSinceLastToolBoundary: runtime.hasTextSinceLastToolBoundary,
        suppressRawToolCallText: runtime.suppressRawToolCallText,
        suppressLeakedCommandSpecText: runtime.suppressLeakedCommandSpecText,
        finishReason: runtime.finishReason,
        providerFields: runtime.providerFields,
        segmentCount: reasoningSegments.length,
        renderBlocks: renderBlocks.mark(),
        toolArgSlots: new Map(
          [...partialToolArgsBySlot].map(([slot, state]) => [
            slot,
            state.args.length,
          ]),
        ),
      };
    },
    /**
     * Withdraw everything a failed model-call attempt streamed since
     * `boundary`: its reasoning segments, its text, its render blocks and its
     * pending tool-arg buffers. Returns what the client must drop, both as
     * this-run lengths to keep (`keep*Chars`) and as tail lengths to cut
     * (`drop*Chars`, which also hold for a client that seeded a prior run's
     * text ahead of this one). The caller resets the reasoning boundary so
     * the retried attempt opens a new segment.
     */
    discardModelOutputSince(boundary: ModelCallBoundary) {
      const segmentIds = reasoningSegments
        .splice(boundary.segmentCount)
        .map((segment) => segment.id);
      const dropTextChars = Math.max(
        0,
        runtime.assistantContent.length - boundary.assistantContent.length,
      );
      const dropReasoningChars = Math.max(
        0,
        (runtime.modelReasoning?.length ?? 0) -
          (boundary.modelReasoning?.length ?? 0),
      );
      runtime.currentReasoningSegment = null;
      currentReasoningSegmentStartedAt = null;

      const toolCallIds: string[] = [];
      for (const [slot, state] of partialToolArgsBySlot) {
        const before = boundary.toolArgSlots.get(slot);
        if (before !== undefined && state.args.length <= before) {
          continue;
        }
        if (state.id && !toolCallsById.has(state.id)) {
          toolCallIds.push(state.id);
        }
        partialToolArgsBySlot.delete(slot);
      }

      renderBlocks.rollback(boundary.renderBlocks);
      runtime.assistantContent = boundary.assistantContent;
      runtime.modelReasoning = boundary.modelReasoning;
      runtime.hasStreamedText = boundary.hasStreamedText;
      runtime.hasTextSinceLastToolBoundary =
        boundary.hasTextSinceLastToolBoundary;
      runtime.suppressRawToolCallText = boundary.suppressRawToolCallText;
      runtime.suppressLeakedCommandSpecText =
        boundary.suppressLeakedCommandSpecText;
      runtime.finishReason = boundary.finishReason;
      runtime.providerFields = boundary.providerFields;

      return {
        segmentIds,
        toolCallIds,
        keepTextChars: boundary.assistantContent.length,
        keepReasoningChars: boundary.modelReasoning?.length ?? 0,
        dropTextChars,
        dropReasoningChars,
      };
    },
    collectRetrievalCalls() {
      return retrievalCallOrder
        .map((callId) => retrievalCallsById.get(callId))
        .filter((call): call is RetrievalCallTrace => Boolean(call));
    },
    collectToolCalls(options: { preserveRunning?: boolean } = {}) {
      return toolCallOrder
        .map((callId) => toolCallsById.get(callId))
        .filter((call): call is ToolCallTrace => Boolean(call))
        .map((call) => {
          if (call.status !== "running" || options.preserveRunning) {
            return call;
          }

          const startedAt = toolStartedAtById.get(call.id);
          return {
            ...call,
            status: "completed" as const,
            latencyMs:
              call.latencyMs ??
              (typeof startedAt === "number" ? Date.now() - startedAt : null),
          };
        });
    },
    setThinkingStep(step: Omit<ThinkingStepTrace, "sequence">) {
      const existing = thinkingStepsById.get(step.id);
      return upsertThinkingStep({
        stepsById: thinkingStepsById,
        stepOrder: thinkingStepOrder,
        step: {
          ...step,
          sequence: existing?.sequence ?? nextSequence(),
        },
      });
    },
    appendReasoningSegment(text: string) {
      const now = Date.now();
      if (!runtime.currentReasoningSegment) {
        currentReasoningSegmentStartedAt = now;
        runtime.currentReasoningSegment = {
          id: createModelReasoningSegmentId({
            runTraceId: input.prepared.runTraceId,
            index: nextReasoningSegmentIndex,
          }),
          text: "",
          sequence: nextSequence(),
          durationMs: 0,
          phase: runtime.nextReasoningContext.phase,
          ...(runtime.nextReasoningContext.phase === "after_tool"
            ? {
                toolCallId: runtime.nextReasoningContext.toolCallId,
                tool: runtime.nextReasoningContext.tool,
              }
            : {}),
        };
        reasoningSegments.push(runtime.currentReasoningSegment);
        nextReasoningSegmentIndex += 1;
      }

      runtime.currentReasoningSegment.durationMs =
        now - (currentReasoningSegmentStartedAt ?? now);
      runtime.currentReasoningSegment.text =
        appendReasoningChunk(runtime.currentReasoningSegment.text, text) ??
        runtime.currentReasoningSegment.text;

      return runtime.currentReasoningSegment;
    },
    recordRetrieval(record: {
      callId: string;
      query: string;
      retrieval: ToolRetrieval;
      latencyMs: number;
    }) {
      runtime.latestToolRetrieval = record.retrieval;

      if (!retrievalCallsById.has(record.callId)) {
        retrievalCallOrder.push(record.callId);
      }

      const retrievalCall: RetrievalCallTrace = {
        id: record.callId,
        tool: AGENT_TOOL_NAMES.searchSources,
        query: record.query,
        hitCount: record.retrieval.fusedCandidates.length,
        latencyMs: record.latencyMs,
      };
      retrievalCallsById.set(record.callId, retrievalCall);
      retrievalsByToolCallId.set(record.callId, record.retrieval);

      return new Map(
        record.retrieval.fusedCandidates.map((candidate) => {
          const citation = citationRegistry.addRetrievalCandidate(candidate);
          return [candidate.chunkId, citation] as const;
        }),
      );
    },
    buildRetrievalChunks(chunkInput: {
      retrieval: ToolRetrieval;
      citationByChunkId: Map<string, RetrievalCitation>;
    }) {
      return chunkInput.retrieval.fusedCandidates.map((candidate, index) => ({
        citation:
          chunkInput.citationByChunkId.get(candidate.chunkId)?.citation ??
          `c${index + 1}`,
        chunkId: candidate.chunkId,
        content: candidate.content,
        sourceTitle: chunkInput.citationByChunkId.get(candidate.chunkId)
          ?.sourceTitle,
      }));
    },
  };

  return runtime;
}
