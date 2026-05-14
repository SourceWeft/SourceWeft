import {
  getModelGatewayClient,
  requireDefaultModelGatewayProfile,
} from "../../../shared/model-gateway/index";
import {
  buildGatewayAuditMetadata,
  buildGatewayRequestMetadata,
  recordGatewayOperationEvent,
  type LlmExecutionConfig,
} from "../model-gateway-audit";
import type { TraceContext } from "../../../shared/llm-observability";
import { toContentServiceError } from "../model-gateway-error";
import type { RetrievalCandidate } from "./planner";
import { DEFAULT_RERANK_TOP_N } from "./pipeline/constants";

export async function rerankCandidates(input: {
  queryText: string;
  candidates: RetrievalCandidate[];
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
}) {
  if (input.candidates.length === 0) {
    return {
      candidates: input.candidates,
      modelAlias: null,
      gateway: buildGatewayAuditMetadata({ llm: input.llm }),
    };
  }

  const rerankProfile = await requireDefaultModelGatewayProfile("rerank");
  const gateway = await getModelGatewayClient(rerankProfile.gatewayConfigId);
  const startedAt = Date.now();
  const rerankResult = await gateway.rerank
    .rank(
      {
        model: rerankProfile.modelAlias,
        query: input.queryText,
        documents: input.candidates.map((candidate) => candidate.content),
        topN: Math.min(input.candidates.length, DEFAULT_RERANK_TOP_N),
        returnDocuments: false,
        metadata: {
          team_id: input.teamId,
          workspace_id: input.workspaceId,
          user_id: input.userId,
          thread_id: input.threadId,
          feature: "retrieval_rerank",
        },
        executionMode: "GLOBAL",
      },
      {
        traceId: input.traceContext?.traceId,
        metadata: {
          ...buildGatewayRequestMetadata({
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
          }),
        },
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
        llm: undefined,
        traceId: input.traceContext?.traceId,
        success: false,
        errorCode: contentError.code,
        errorMessage: contentError.message,
        latencyMs: Date.now() - startedAt,
      });
      throw contentError;
    });

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
      inputCandidateCount: input.candidates.length,
      outputCandidateCount: rerankResult.results.length,
    },
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
