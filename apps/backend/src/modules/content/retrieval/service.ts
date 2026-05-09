import { buildCitationMetadata } from "./planner";
import { endSpan, startSpan } from "../../../shared/llm-observability";
import { createDefaultRetrievalPipeline } from "./pipeline/default";
import { runRetrievalPipeline } from "./pipeline/runner";
import {
  createInitialRetrievalState,
  requirePreparedRetrievalState,
} from "./pipeline/state";
import type { RetrievalInput } from "./pipeline/types";

class ContentRetrievalService {
  async runRetrieval(input: RetrievalInput) {
    const spanId = input.traceContext?.parentSpanId
      ? `retrieval:${input.traceContext.parentSpanId}`
      : "retrieval";
    const startedAt = Date.now();
    if (input.traceContext) {
      await startSpan({
        ...input.traceContext,
        spanId,
        parentSpanId: input.traceContext.parentSpanId,
        name: "retrieval",
        kind: "retrieval",
        operation: "retrieval.run",
        input: {
          query: input.queryText,
          anchorSourceIds: input.anchorSourceIds ?? [],
          sourceIds: input.sourceIds,
        },
      });
    }

    try {
      const state = await runRetrievalPipeline({
        initialState: createInitialRetrievalState({
          ...input,
          traceContext: input.traceContext
            ? { ...input.traceContext, parentSpanId: spanId }
            : undefined,
        }),
        stages: createDefaultRetrievalPipeline(),
      });
      const prepared = requirePreparedRetrievalState(state);

      if (input.traceContext) {
        await endSpan({
          traceId: input.traceContext.traceId,
          teamId: input.traceContext.teamId,
          workspaceId: input.traceContext.workspaceId,
          spanId,
          status: "ok",
          latencyMs: Date.now() - startedAt,
          output: {
            finalResultCount: state.candidates.final.length,
            anchorSourceIds: prepared.anchorSourceIds,
            retrievalSourceIds: prepared.retrievalSourceIds,
            contextAssembly: state.contextAssembly,
            embeddingLatencyMs: state.timings.embeddingLatencyMs,
            bm25LatencyMs: state.timings.bm25LatencyMs,
            vectorLatencyMs: state.timings.vectorLatencyMs,
            rerankLatencyMs: state.timings.rerankLatencyMs,
          },
        });
      }

      return {
        profile: prepared.profile,
        planner: prepared.planner,
        fusedCandidates: state.candidates.final,
        retrievalSummary: buildCitationMetadata(state.candidates.final),
        contextAssembly: state.contextAssembly,
      };
    } catch (error) {
      if (input.traceContext) {
        await endSpan({
          traceId: input.traceContext.traceId,
          teamId: input.traceContext.teamId,
          workspaceId: input.traceContext.workspaceId,
          spanId,
          status: "error",
          latencyMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }
}

export const contentRetrievalService = new ContentRetrievalService();
