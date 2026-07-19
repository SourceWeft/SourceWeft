import type {
  ContextAssemblyMetadata,
  RetrievalCandidate,
  RetrievalPlannerResult,
} from "../types";
import type { RetrievalPipelineStage as PackageRetrievalPipelineStage } from "../pipeline-contracts";
import type { EmbeddingProfile } from "../data-access";

/**
 * Recall/precision knobs. Every field is optional; unset fields fall back to
 * the DEFAULT_* constants, so existing callers keep their current behaviour.
 */
export type RetrievalTuning = {
  vectorTopK?: number;
  bm25TopK?: number;
  rrfK?: number;
  fusionLimit?: number;
  rerankTopN?: number;
};

/** Same shape with every value resolved, carried on the pipeline state. */
export type ResolvedRetrievalTuning = Required<RetrievalTuning>;

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
  tuning?: RetrievalTuning;
};

/**
 * A stage that failed but did not abort the run. Surfaced in the retrieval run
 * audit record so a persistently broken subsystem (e.g. the BM25 index) is
 * visible instead of silently halving recall.
 */
export type RetrievalDegradation = {
  stage: string;
  reason: string;
};

export type RetrievalPipelineState = {
  input: RetrievalInput;
  /** Resolved once so search, ranking, and the audit record agree. */
  tuning: ResolvedRetrievalTuning;
  degradations: RetrievalDegradation[];
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
