import type { TraceContext } from "../../../llm-observability";
import { endSpan, startSpan } from "../../../llm-observability";
import type { LlmExecutionConfig } from "../../../content/model-gateway-audit";
import type { PreparedThreadTurn } from "../..";
import {
  runRetrieval,
  type RetrievalDataAccess,
  type RetrievalEmbeddingGateway,
  type RerankGateway,
} from "@sourceweft/builtin-retrieval";
import {
  findDefaultEmbeddingProfile,
  listSourceChunksByProfile,
  searchChunksByBm25,
  searchChunksByVectorAnn,
  searchChunksByVectorExact,
  listDocumentChunkStats,
  listDocumentChunksForDocument,
  listDocumentChunksInRange,
  createRetrievalRun,
  createRetrievalHits,
} from "../../../sources/retrieval-repository";
import {
  getModelGatewayClient,
  requireDefaultModelGatewayProfile,
  resolveModelGatewayProfile,
} from "../../../../shared/model-gateway/index";
import {
  buildGatewayRequestMetadata,
  recordGatewayOperationEvent,
} from "../../../content/model-gateway-audit";
import { toContentError } from "../../../content/model-gateway-error";
import { planRetrievalStrategy } from "../../../sources/retrieval-planner";

// ── Wiring: backend implementations of package interfaces ────────────────────

function createDataAccess(): RetrievalDataAccess {
  return {
    findDefaultEmbeddingProfile,
    listSourceChunksByProfile,
    searchChunksByBm25,
    searchChunksByVectorAnn,
    searchChunksByVectorExact,
    listDocumentChunkStats,
    listDocumentChunksForDocument,
    listDocumentChunksInRange,
    createRetrievalRun,
    createRetrievalHits,
  };
}

function createEmbeddingGateway(): RetrievalEmbeddingGateway {
  return {
    embed: async (input) => {
      const profile = await requireDefaultModelGatewayProfile("embedding");
      const gateway = await getModelGatewayClient(profile.gatewayConfigId);
      const result = await gateway.embeddings.embed({
        model: input.modelAlias || profile.modelAlias,
        text: input.queryText,
        dimensions: input.dimensions || undefined,
        executionMode: "GLOBAL",
      });
      return result.embedding;
    },
  };
}

async function createRerankGateway(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  traceContext?: TraceContext;
}): Promise<RerankGateway> {
  const rerankProfile = await resolveModelGatewayProfile({
    kind: "rerank",
    defaultRequired: false,
  });
  if (!rerankProfile) {
    return {
      async rank() {
        return [];
      },
    };
  }

  const rerankClient = await getModelGatewayClient(
    rerankProfile.gatewayConfigId,
  );

  return {
    rank: async (req) => {
      const startedAt = Date.now();
      const requestMetadata = buildGatewayRequestMetadata({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        threadId: input.threadId,
        feature: "retrieval_rerank",
        operation: "rerank.rank",
        modelKind: "rerank",
        modelAlias: rerankProfile.modelAlias,
        llm: undefined,
        parentSpanId: input.traceContext?.parentSpanId,
      });

      try {
        const rerankResult = await rerankClient.rerank.rank(
          {
            model: rerankProfile.modelAlias,
            query: req.query,
            documents: req.documents,
            topN: req.topN,
            returnDocuments: false,
            executionMode: "GLOBAL",
          },
          {
            traceId: input.traceContext?.traceId,
            metadata: requestMetadata,
          },
        );

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
          llm: undefined,
          provider: rerankResult.provider,
          routeDecision: rerankResult.routeDecision as unknown as Record<
            string,
            unknown
          > | null,
          usage: rerankResult.usage,
          traceId: input.traceContext?.traceId,
          success: true,
          latencyMs: Date.now() - startedAt,
          attributes: {
            inputCandidateCount: req.documents.length,
            outputCandidateCount: rerankResult.results.length,
          },
        });

        return rerankResult.results.map((r) => ({
          index: r.index,
          relevanceScore: r.relevanceScore,
        }));
      } catch (error) {
        const contentError = toContentError(error);
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
          llm: undefined,
          traceId: input.traceContext?.traceId,
          success: false,
          errorCode: contentError.code,
          errorMessage: contentError.message,
          latencyMs: Date.now() - startedAt,
        });
        throw contentError;
      }
    },
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function runToolRetrieval(input: {
  prepared: PreparedThreadTurn;
  query: string;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
}) {
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
        query: input.query,
        anchorSourceIds: input.prepared.effectiveMentionedSourceIds,
        sourceIds: input.prepared.sourceIds,
      },
    });
  }

  try {
    const rerankGateway = await createRerankGateway({
      teamId: input.prepared.workspace.organizationId,
      workspaceId: input.prepared.workspace.id,
      threadId: input.prepared.thread.id,
      userId: input.prepared.userId,
      traceContext: input.traceContext,
    });

    const result = await runRetrieval(
      {
        workspaceId: input.prepared.workspace.id,
        teamId: input.prepared.workspace.organizationId,
        threadId: input.prepared.thread.id,
        userId: input.prepared.userId,
        userMessageId: input.prepared.userMessage.id,
        queryText: input.query,
        anchorSourceIds: input.prepared.effectiveMentionedSourceIds,
        sourceIds: input.prepared.sourceIds,
        idempotencyKey: input.prepared.llmIdempotencyKey,
      },
      {
        dataAccess: createDataAccess(),
        embeddingGateway: createEmbeddingGateway(),
        rerankGateway,
        planStrategy: planRetrievalStrategy,
      },
    );

    if (input.traceContext) {
      await endSpan({
        traceId: input.traceContext.traceId,
        teamId: input.traceContext.teamId,
        workspaceId: input.traceContext.workspaceId,
        spanId,
        status: "ok",
        latencyMs: Date.now() - startedAt,
        output: {
          finalResultCount: result.fusedCandidates.length,
          contextAssembly: result.contextAssembly,
          ...result.timings,
        },
      });
    }

    return result;
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
