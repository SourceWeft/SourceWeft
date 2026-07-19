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
  requireDefaultModelGatewayProfile,
  resolveModelGatewayProfile,
  withBilledModelGateway,
  type BilledModelGateway,
} from "../../../../shared/model-gateway/index";
import type { ContentBillingPort } from "../../../content/billing-port";
import { recordGatewayOperationEvent } from "../../../content/model-gateway-audit";
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

function createEmbeddingGateway(
  gateway: BilledModelGateway,
): RetrievalEmbeddingGateway {
  return {
    embed: async (input) => {
      const profile = await requireDefaultModelGatewayProfile("embedding");
      const result = await gateway.embeddings.embed(
        {
          model: input.modelAlias || profile.modelAlias,
          text: input.queryText,
          dimensions: input.dimensions || undefined,
          executionMode: "GLOBAL",
        },
        {
          operation: "embeddings.embed",
          modelKind: "embedding",
          gatewayConfigId: profile.gatewayConfigId,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
        },
      );
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
  gateway: BilledModelGateway;
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

  return {
    rank: async (req) => {
      const startedAt = Date.now();

      try {
        const rerankResult = await input.gateway.rerank.rank(
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
            operation: "rerank.rank",
            modelKind: "rerank",
            gatewayConfigId: rerankProfile.gatewayConfigId,
            profileAlias: rerankProfile.profileAlias,
            modelAlias: rerankProfile.modelAlias,
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
  billing: ContentBillingPort;
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
    // Retrieval embeddings and rerank are deliberately not charged to the
    // customer, but their cost is now recorded against the generation rather
    // than being invisible. Declaring the intent is what makes that a decision
    // rather than an omission.
    const result = await withBilledModelGateway(
      {
        billing: input.billing,
        context: {
          teamId: input.prepared.workspace.organizationId,
          workspaceId: input.prepared.workspace.id,
          actorUserId: input.prepared.userId,
          feature: "retrieval",
          intent: {
            mode: "covered",
            coveredBy: "model_kind_not_user_billed",
          },
          scopeKind: "thread-turn",
          scopeId:
            input.traceContext?.traceId ?? input.prepared.userMessage.id,
          threadId: input.prepared.thread.id,
          messageId: input.prepared.userMessage.id,
        },
      },
      async (gateway) => {
        const rerankGateway = await createRerankGateway({
          teamId: input.prepared.workspace.organizationId,
          workspaceId: input.prepared.workspace.id,
          threadId: input.prepared.thread.id,
          userId: input.prepared.userId,
          traceContext: input.traceContext,
          gateway,
        });

        return runRetrieval(
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
            embeddingGateway: createEmbeddingGateway(gateway),
            rerankGateway,
            planStrategy: planRetrievalStrategy,
          },
        );
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
