import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { TraceContext } from "../../../../shared/llm-observability";
import type { EmbeddingProfileRecord } from "../../types";
import type { RetrievalCandidate, RetrievalPlannerResult } from "../planner";

export type ContextAssemblyMetadata = {
  primaryCandidateCount: number;
  assembledChunkCount: number;
  expandedNeighborCount: number;
  smallDocumentCount: number;
  finalContextChars: number;
  documentCount: number;
  contextTruncated: boolean;
};

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
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
};

export type RetrievalPipelineState = {
  input: RetrievalInput;
  anchorSourceIds: string[];
  retrievalSourceIds: string[];
  sourceIds: string[];
  profile: EmbeddingProfileRecord | null;
  planner: RetrievalPlannerResult | null;
  queryEmbedding: number[];
  candidates: {
    bm25: RetrievalCandidate[];
    vector: RetrievalCandidate[];
    fused: RetrievalCandidate[];
    final: RetrievalCandidate[];
  };
  modelAliases: {
    embed: string | null;
    rerank: string | null;
  };
  timings: {
    embeddingLatencyMs: number;
    bm25LatencyMs: number;
    vectorLatencyMs: number;
    rerankLatencyMs: number;
    retrievalLatencyMs: number;
  };
  gateway: {
    embedding: Record<string, unknown> | null;
    rerank: Record<string, unknown> | null;
  };
  contextAssembly: ContextAssemblyMetadata | null;
  retrievalRunId: string | null;
};

export type PreparedRetrievalPipelineState = RetrievalPipelineState & {
  profile: EmbeddingProfileRecord;
  planner: RetrievalPlannerResult;
};

export type RetrievalPipelineStage = {
  name: string;
  run(state: RetrievalPipelineState): Promise<RetrievalPipelineState>;
};
