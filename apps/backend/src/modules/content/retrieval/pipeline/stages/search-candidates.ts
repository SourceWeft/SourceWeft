import { getModelGatewayClient } from "../../../../../shared/model-gateway/index";
import {
  buildGatewayAuditMetadata,
  buildGatewayRequestMetadata,
  recordGatewayOperationEvent,
} from "../../../model-gateway-audit";
import { toContentServiceError } from "../../../model-gateway-error";
import { vectorSearchProvider } from "../../../vector";
import { endSpan, startSpan, type TraceContext } from "../../../../../shared/llm-observability";
import { searchChunksByBm25 } from "../../repository";
import {
  DEFAULT_BM25_TOP_K,
  DEFAULT_VECTOR_TOP_K,
} from "../constants";
import { requirePreparedRetrievalState } from "../state";
import type { RetrievalPipelineStage } from "../types";

async function withRetrievalChildSpan<T>(input: {
  traceContext: TraceContext;
  spanId: string;
  name: string;
  kind: "bm25" | "vector_search";
  operation: string;
  metadata?: Record<string, unknown>;
  execute: () => Promise<T>;
}) {
  const startedAt = Date.now();
  await startSpan({
    ...input.traceContext,
    spanId: input.spanId,
    parentSpanId: input.traceContext.parentSpanId,
    name: input.name,
    kind: input.kind,
    operation: input.operation,
    metadata: input.metadata,
  });

  try {
    const output = await input.execute();
    await endSpan({
      traceId: input.traceContext.traceId,
      spanId: input.spanId,
      status: "ok",
      latencyMs: Date.now() - startedAt,
      output: Array.isArray(output) ? { resultCount: output.length } : undefined,
    });
    return output;
  } catch (error) {
    await endSpan({
      traceId: input.traceContext.traceId,
      spanId: input.spanId,
      status: "error",
      latencyMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function buildRetrievalChildSpanId(input: TraceContext, suffix: string) {
  return `${input.parentSpanId ?? "retrieval"}:${suffix}`;
}

export const searchCandidatesStage: RetrievalPipelineStage = {
  name: "search-candidates",
  async run(state) {
    const prepared = requirePreparedRetrievalState(state);
    const { input, planner, profile, sourceIds } = prepared;

    if (sourceIds.length === 0) {
      return state;
    }

    let queryEmbedding = state.queryEmbedding;
    let embeddingLatencyMs = state.timings.embeddingLatencyMs;
    let embeddingAuditMetadata = state.gateway.embedding;

    if (planner.strategy !== "bm25_only") {
      const embeddingGateway = await getModelGatewayClient(profile.gatewayConfigId);
      const embedStartedAt = Date.now();
      const embedResult = await embeddingGateway.embeddings
        .embed(
          {
            model: profile.modelAlias,
            text: input.queryText,
            dimensions: planner.requestedDimensions ?? undefined,
            metadata: {
              team_id: input.teamId,
              workspace_id: input.workspaceId,
              user_id: input.userId,
              thread_id: input.threadId,
              feature: "retrieval",
            },
            executionMode: input.llm?.executionMode,
            providerHint: input.llm?.providerHint,
            byok: input.llm?.byok,
          },
          {
            idempotencyKey:
              input.idempotencyKey ||
              `thread-stream:${input.userMessageId}:query-embed`,
            traceId: input.traceContext?.traceId ?? input.userMessageId,
            metadata: {
              ...buildGatewayRequestMetadata({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                userId: input.userId,
                threadId: input.threadId,
                messageId: input.userMessageId,
                feature: "retrieval",
                operation: "embeddings.embed",
                modelAlias: profile.modelAlias,
                llm: input.llm,
                parentSpanId: input.traceContext?.parentSpanId,
              }),
            },
          },
        )
        .catch((error: unknown) => {
          throw toContentServiceError(error);
        });
      queryEmbedding = embedResult.embedding;
      embeddingLatencyMs = Date.now() - embedStartedAt;
      embeddingAuditMetadata = buildGatewayAuditMetadata({
        llm: input.llm,
        provider: embedResult.provider,
        routeDecision: embedResult.routeDecision as
          | Record<string, unknown>
          | undefined,
      });
      await recordGatewayOperationEvent({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        threadId: input.threadId,
        messageId: input.userMessageId,
        feature: "retrieval",
        operation: "embeddings.embed",
        modelKind: "embedding",
        modelAlias: profile.modelAlias,
        llm: input.llm,
        provider: embedResult.provider,
        routeDecision: embedResult.routeDecision as
          | Record<string, unknown>
          | undefined,
        usage: embedResult.usage,
        traceId: input.traceContext?.traceId ?? input.userMessageId,
        success: true,
        latencyMs: embeddingLatencyMs,
      });
    }

    const bm25StartedAt = Date.now();
    const runBm25 = () => searchChunksByBm25({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        queryText: input.queryText,
        topK: DEFAULT_BM25_TOP_K,
        sourceIds,
      });
    const bm25Candidates = input.traceContext
      ? await withRetrievalChildSpan({
          traceContext: input.traceContext,
          spanId: buildRetrievalChildSpanId(input.traceContext, "bm25"),
          name: "bm25",
          kind: "bm25",
          operation: "retrieval.bm25",
          metadata: {
            topK: DEFAULT_BM25_TOP_K,
            sourceCount: sourceIds.length,
          },
          execute: runBm25,
        })
      : await runBm25();
    const bm25LatencyMs = Date.now() - bm25StartedAt;

    const vectorStartedAt = Date.now();
    const runVectorSearch = async () =>
      planner.strategy === "ann_hnsw" && planner.requestedDimensions
        ? vectorSearchProvider.searchAnn({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          embeddingProfileId: profile.id,
          queryEmbedding,
          dim: planner.requestedDimensions,
          topK: DEFAULT_VECTOR_TOP_K,
          sourceIds,
        })
        : planner.strategy !== "bm25_only"
          ? vectorSearchProvider.searchExact({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            embeddingProfileId: profile.id,
            queryEmbedding,
            topK: DEFAULT_VECTOR_TOP_K,
            sourceIds,
          })
          : [];
    const vectorCandidates = input.traceContext && planner.strategy !== "bm25_only"
      ? await withRetrievalChildSpan({
          traceContext: input.traceContext,
          spanId: buildRetrievalChildSpanId(input.traceContext, "vector_search"),
          name: "vector_search",
          kind: "vector_search",
          operation: "retrieval.vector_search",
          metadata: {
            strategy: planner.strategy,
            embeddingProfileId: profile.id,
            topK: DEFAULT_VECTOR_TOP_K,
            sourceCount: sourceIds.length,
          },
          execute: runVectorSearch,
        })
      : await runVectorSearch();
    const vectorLatencyMs = Date.now() - vectorStartedAt;

    return {
      ...state,
      queryEmbedding,
      candidates: {
        ...state.candidates,
        bm25: bm25Candidates,
        vector: vectorCandidates,
      },
      timings: {
        ...state.timings,
        embeddingLatencyMs,
        bm25LatencyMs,
        vectorLatencyMs,
      },
      gateway: {
        ...state.gateway,
        embedding: embeddingAuditMetadata,
      },
    };
  },
};
