import {
  ensureModelConfigAvailable,
  getModelGatewayClient,
  requireDefaultModelGatewayProfile,
} from "../../../shared/model-gateway/index";
import {
  buildGatewayAuditMetadata,
  buildGatewayRequestMetadata,
  recordGatewayOperationEvent,
  type LlmExecutionConfig,
} from "../model-gateway-audit";
import { toContentServiceError } from "../model-gateway-error";
import { vectorSearchProvider } from "../vector";
import {
  createRetrievalHits,
  createRetrievalRun,
  searchChunksByBm25,
} from "./repository";
import {
  buildCitationMetadata,
  planRetrievalStrategy,
  reciprocalRankFusion,
  type RetrievalCandidate,
} from "./planner";
import { ContentError } from "../errors";

const DEFAULT_RRF_K = 60;
const DEFAULT_VECTOR_TOP_K = 8;
const DEFAULT_BM25_TOP_K = 12;

async function requireDefaultEmbeddingProfile() {
  try {
    const profile = await requireDefaultModelGatewayProfile("embedding");
    return {
      ...profile,
      kind: "embedding" as const,
    };
  } catch {
    throw new ContentError(
      500,
      "EMBEDDING_PROFILE_NOT_CONFIGURED",
      "Default embedding profile is not configured",
    );
  }
}

async function rerankCandidates(input: {
  queryText: string;
  candidates: RetrievalCandidate[];
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  llm?: LlmExecutionConfig;
}) {
  if (input.candidates.length <= 1) {
    return {
      candidates: input.candidates,
      modelAlias: null,
      gateway: buildGatewayAuditMetadata({ llm: input.llm }),
    };
  }

  const rerankProfile = await requireDefaultModelGatewayProfile("rerank");
  const gateway = await getModelGatewayClient(rerankProfile.gatewayConfigId);
  const rerankResult = await gateway.rerank
    .rank(
      {
        model: rerankProfile.modelAlias,
        query: input.queryText,
        documents: input.candidates.map((candidate) => candidate.content),
        topN: Math.min(input.candidates.length, 6),
        returnDocuments: false,
        metadata: {
          team_id: input.teamId,
          workspace_id: input.workspaceId,
          user_id: input.userId,
          thread_id: input.threadId,
          feature: "retrieval_rerank",
        },
        executionMode: input.llm?.executionMode,
        providerHint: input.llm?.providerHint,
        byok: input.llm?.byok,
      },
      {
        metadata: buildGatewayRequestMetadata({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          threadId: input.threadId,
          feature: "retrieval_rerank",
          operation: "rerank.rank",
          modelKind: "rerank",
          modelAlias: rerankProfile.modelAlias,
          llm: input.llm,
        }),
      },
    )
    .catch(async (error: unknown) => {
      const contentError = toContentServiceError(error);
      await recordGatewayOperationEvent({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        threadId: input.threadId,
        messageId: null,
        feature: "retrieval_rerank",
        operation: "rerank.rank",
        modelKind: "rerank",
        modelAlias: rerankProfile.modelAlias,
        llm: input.llm,
        success: false,
        errorCode: contentError.code,
        errorMessage: contentError.message,
      });
      throw contentError;
    });

  return {
    modelAlias: rerankProfile.modelAlias,
    candidates: rerankResult.results
      .map((item) => {
        const candidate = input.candidates[item.index];
        if (!candidate) {
          return null;
        }
        return {
          ...candidate,
          score: item.relevanceScore,
        };
      })
      .filter(
        (candidate): candidate is RetrievalCandidate => candidate !== null,
      ),
  };
}

class ContentRetrievalService {
  async runRetrieval(input: {
    workspaceId: string;
    teamId: string;
    threadId: string;
    userId: string;
    userMessageId: string;
    queryText: string;
    sourceIds: string[];
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
  }) {
    await ensureModelConfigAvailable();
    const profile = await requireDefaultEmbeddingProfile();
    const embeddingGateway = await getModelGatewayClient(profile.gatewayConfigId);
    const planner = planRetrievalStrategy(profile);
    const sourceIds = [...new Set(input.sourceIds)];

    if (sourceIds.length === 0) {
      const retrievalRunId = await createRetrievalRun({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        messageId: input.userMessageId,
        embeddingProfileId: profile.id,
        queryText: input.queryText,
        embedModelAlias: profile.modelAlias,
        rerankModelAlias: null,
        vectorStrategyUsed: planner.strategy,
        annIndexUsed: planner.annIndexUsed,
        bm25TopK: DEFAULT_BM25_TOP_K,
        vectorTopK: DEFAULT_VECTOR_TOP_K,
        rrfK: DEFAULT_RRF_K,
        prefilterCount: 0,
        candidateCount: 0,
        finalResultCount: 0,
        latencyMs: 0,
        metadataJson: {
          requestedSourceIds: sourceIds,
          gateway: {
            embedding: null,
            rerank: buildGatewayAuditMetadata({ llm: input.llm }),
          },
        },
      });

      await createRetrievalHits({
        runId: retrievalRunId,
        hits: [],
      });

      return {
        profile,
        planner,
        fusedCandidates: [],
        retrievalSummary: [] as ReturnType<typeof buildCitationMetadata>,
      };
    }

    const startedAt = Date.now();
    let embeddingLatencyMs = 0;
    let bm25LatencyMs = 0;
    let vectorLatencyMs = 0;
    let rerankLatencyMs = 0;
    let queryEmbedding: number[] = [];
    let embeddingAuditMetadata: Record<string, unknown> | null = null;
    if (planner.strategy !== "bm25_only") {
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
        providerModel: embedResult.providerModel,
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
        providerModel: embedResult.providerModel,
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
    const lexicalCandidates = await searchChunksByBm25({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      queryText: input.queryText,
      topK: DEFAULT_BM25_TOP_K,
      sourceIds,
    });
    bm25LatencyMs = Date.now() - bm25StartedAt;

    let vectorCandidates: RetrievalCandidate[] = [];
    const vectorStartedAt = Date.now();
    if (planner.strategy === "ann_hnsw" && planner.requestedDimensions) {
      vectorCandidates = await vectorSearchProvider.searchAnn({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        embeddingProfileId: profile.id,
        queryEmbedding,
        dim: planner.requestedDimensions,
        topK: DEFAULT_VECTOR_TOP_K,
        sourceIds,
      });
    } else if (planner.strategy !== "bm25_only") {
      vectorCandidates = await vectorSearchProvider.searchExact({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        embeddingProfileId: profile.id,
        queryEmbedding,
        topK: DEFAULT_VECTOR_TOP_K,
        sourceIds,
      });
    }
    vectorLatencyMs = Date.now() - vectorStartedAt;

    const fusedCandidates = reciprocalRankFusion({
      vectorCandidates,
      bm25Candidates: lexicalCandidates,
      limit: 8,
      rrfK: DEFAULT_RRF_K,
    });
    const rerankStartedAt = Date.now();
    const rerank = await rerankCandidates({
      queryText: input.queryText,
      candidates: fusedCandidates,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      llm: input.llm,
    });
    rerankLatencyMs = Date.now() - rerankStartedAt;
    const rerankedCandidates = rerank.candidates;
    const finalCandidates =
      rerankedCandidates.length > 0 ? rerankedCandidates : fusedCandidates;
    const retrievalLatencyMs = Date.now() - startedAt;

    const retrievalRunId = await createRetrievalRun({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      messageId: input.userMessageId,
      embeddingProfileId: profile.id,
      queryText: input.queryText,
      embedModelAlias: profile.modelAlias,
      rerankModelAlias: rerank.modelAlias,
      vectorStrategyUsed: planner.strategy,
      annIndexUsed: planner.annIndexUsed,
      bm25TopK: DEFAULT_BM25_TOP_K,
      vectorTopK: DEFAULT_VECTOR_TOP_K,
      rrfK: DEFAULT_RRF_K,
      prefilterCount: null,
      candidateCount: Math.max(lexicalCandidates.length, vectorCandidates.length),
      finalResultCount: finalCandidates.length,
      latencyMs: retrievalLatencyMs,
      metadataJson: {
        requestedSourceIds: sourceIds,
        timings: {
          embeddingLatencyMs,
          bm25LatencyMs,
          vectorLatencyMs,
          rerankLatencyMs,
          retrievalLatencyMs,
        },
        gateway: {
          embedding: embeddingAuditMetadata,
          rerank: rerank.gateway,
        },
      },
    });

    await createRetrievalHits({
      runId: retrievalRunId,
      hits: [
        ...vectorCandidates.map(
          (candidate: RetrievalCandidate, index: number) => ({
            sourceStage: "vector" as const,
            hitType: "chunk" as const,
            sourceId: candidate.sourceId,
            documentId: candidate.documentId,
            chunkId: candidate.chunkId,
            rank: index + 1,
            score: candidate.score,
          }),
        ),
        ...lexicalCandidates.map(
          (candidate: RetrievalCandidate, index: number) => ({
            sourceStage: "bm25" as const,
            hitType: "chunk" as const,
            sourceId: candidate.sourceId,
            documentId: candidate.documentId,
            chunkId: candidate.chunkId,
            rank: index + 1,
            score: candidate.score,
          }),
        ),
        ...fusedCandidates.map(
          (candidate: RetrievalCandidate, index: number) => ({
            sourceStage: "rrf" as const,
            hitType: "chunk" as const,
            sourceId: candidate.sourceId,
            documentId: candidate.documentId,
            chunkId: candidate.chunkId,
            rank: index + 1,
            score: candidate.score,
          }),
        ),
        ...finalCandidates.map(
          (candidate: RetrievalCandidate, index: number) => ({
            sourceStage: "rerank" as const,
            hitType: "chunk" as const,
            sourceId: candidate.sourceId,
            documentId: candidate.documentId,
            chunkId: candidate.chunkId,
            rank: index + 1,
            score: candidate.score,
          }),
        ),
      ],
    });

    return {
      profile,
      planner,
      fusedCandidates: finalCandidates,
      retrievalSummary: buildCitationMetadata(finalCandidates),
    };
  }
}

export const contentRetrievalService = new ContentRetrievalService();
