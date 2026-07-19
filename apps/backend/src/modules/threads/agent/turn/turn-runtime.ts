import { AgentCitationRegistry } from "../citation-registry";
import type {
  PreparedThreadTurn,
  RetrievalCallTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../..";
import { createMessageRenderBlockBuilder } from "../../turn/render-blocks";
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

export function createTurnRuntime(input: { prepared: PreparedThreadTurn }) {
  const retrievalCallsById = new Map<string, RetrievalCallTrace>();
  const retrievalsByToolCallId = new Map<string, ToolRetrieval>();
  const retrievalCallOrder: string[] = [];
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];
  const toolStartedAtById = new Map<string, number>();
  const pendingToolStreamsByRunId = new Map<string, PendingToolStream>();
  const observedToolCallsById = new Map<string, ObservedAgentToolCall>();
  const sandboxToolCallAliasesById = new Map<string, string>();
  const thinkingStepsById = new Map<string, ThinkingStepTrace>();
  const thinkingStepOrder: string[] = [];
  const reasoningSegments: DeepAgentTurnOutcome["reasoningSegments"] = [];
  const renderBlocks = createMessageRenderBlockBuilder();
  const runStartedAt = Date.now();
  let currentReasoningSegmentStartedAt: number | null = null;
  const citationRegistry = new AgentCitationRegistry();
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
    toolCallOrder,
    toolStartedAtById,
    pendingToolStreamsByRunId,
    observedToolCallsById,
    sandboxToolCallAliasesById,
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
      | DeepAgentTurnOutcome["reasoningSegments"][number]
      | null,
    nextReasoningContext: { phase: "initial" } as
      | { phase: "initial" }
      | { phase: "after_tool"; toolCallId: string; tool: string },
    resetReasoningBoundary() {
      runtime.currentReasoningSegment = null;
      currentReasoningSegmentStartedAt = null;
    },
    collectRetrievalCalls() {
      return retrievalCallOrder
        .map((callId) => retrievalCallsById.get(callId))
        .filter((call): call is RetrievalCallTrace => Boolean(call));
    },
    collectToolCalls() {
      return toolCallOrder
        .map((callId) => toolCallsById.get(callId))
        .filter((call): call is ToolCallTrace => Boolean(call))
        .map((call) => {
          if (call.status !== "running") {
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
            index: reasoningSegments.length + 1,
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
