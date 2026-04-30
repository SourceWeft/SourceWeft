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
        topN: Math.min(input.candidates.length, DEFAULT_RERANK_TOP_N),
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
