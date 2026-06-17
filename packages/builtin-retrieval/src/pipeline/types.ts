import type {
  ContextAssemblyMetadata,
  RetrievalCandidate,
  RetrievalPlannerResult,
} from "../types";
import type { RetrievalPipelineStage as PackageRetrievalPipelineStage } from "../pipeline-contracts";
import type { EmbeddingProfile } from "../data-access";

export type RetrievalInput = {
  workspaceId: string;
  teamId: string;
  threadId: string;
  userId: string;
  userMessageId: string;
  queryText: string;
  sourceIds: string[];
  anchorSourceIds?: string[];
  idempotencyKey?: string;
  llm?: unknown;
  traceContext?: unknown;
};

export type RetrievalPipelineState = {
  input: RetrievalInput;
  anchorSourceIds: string[];
  retrievalSourceIds: string[];
  sourceIds: string[];
  profile: EmbeddingProfile | null;
  planner: RetrievalPlannerResult | null;
  queryEmbedding: number[];
  candidates: {
    bm25: RetrievalCandidate[];
    vector: RetrievalCandidate[];
    fused: RetrievalCandidate[];
    final: RetrievalCandidate[];
  };
  timings: {
    embeddingLatencyMs: number;
    bm25LatencyMs: number;
    vectorLatencyMs: number;
    rerankLatencyMs: number;
  };
  gateway: {
    embedding: Record<string, unknown> | null;
    rerank: Record<string, unknown> | null;
  };
  contextAssembly: ContextAssemblyMetadata | null;
  retrievalRunId: string | null;
};

export type PreparedRetrievalPipelineState = RetrievalPipelineState & {
  profile: EmbeddingProfile;
  planner: RetrievalPlannerResult;
};

export type RetrievalPipelineStage =
  PackageRetrievalPipelineStage<RetrievalPipelineState>;

export type { ContextAssemblyMetadata, RetrievalCandidate };
