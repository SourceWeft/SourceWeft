import { getModelGatewayClient } from "../../../../../shared/model-gateway/index";
import {
  buildGatewayAuditMetadata,
  buildGatewayRequestMetadata,
  recordGatewayOperationEvent,
} from "../../../model-gateway-audit";
import { toContentServiceError } from "../../../model-gateway-error";
import { vectorSearchProvider } from "../../../vector";
import { searchChunksByBm25 } from "../../repository";
import {
  DEFAULT_BM25_TOP_K,
  DEFAULT_VECTOR_TOP_K,
} from "../constants";
import { requirePreparedRetrievalState } from "../state";
import type { RetrievalPipelineStage } from "../types";

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
            traceId: input.userMessageId,
            metadata: buildGatewayRequestMetadata({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              userId: input.userId,
              threadId: input.threadId,
              messageId: input.userMessageId,
              feature: "retrieval",
              operation: "embeddings.embed",
              modelAlias: profile.modelAlias,
              llm: input.llm,
            }),
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
        traceId: input.userMessageId,
        success: true,
        latencyMs: embeddingLatencyMs,
      });
    }

    const bm25StartedAt = Date.now();
    const bm25Candidates = await searchChunksByBm25({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      queryText: input.queryText,
      topK: DEFAULT_BM25_TOP_K,
      sourceIds,
    });
    const bm25LatencyMs = Date.now() - bm25StartedAt;

    const vectorStartedAt = Date.now();
    const vectorCandidates =
      planner.strategy === "ann_hnsw" && planner.requestedDimensions
        ? await vectorSearchProvider.searchAnn({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            embeddingProfileId: profile.id,
            queryEmbedding,
            dim: planner.requestedDimensions,
            topK: DEFAULT_VECTOR_TOP_K,
            sourceIds,
          })
        : planner.strategy !== "bm25_only"
          ? await vectorSearchProvider.searchExact({
              teamId: input.teamId,
              workspaceId: input.workspaceId,
              embeddingProfileId: profile.id,
              queryEmbedding,
              topK: DEFAULT_VECTOR_TOP_K,
              sourceIds,
            })
          : [];
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
