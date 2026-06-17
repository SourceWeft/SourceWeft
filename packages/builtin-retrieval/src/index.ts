export { retrievalAgentToolDefs, searchSourcesAgentTool } from "./agent-tool-defs";

export const builtinRetrievalCapability = {
  id: "sourceweft/retrieval",
} as const;

export { createCapabilityAgentTools } from "./agent-tools";
export { builtinRetrievalCapabilityManifest } from "./manifest";
export {
  DEFAULT_BM25_TOP_K,
  DEFAULT_CONTEXT_MAX_SIDE_CHUNKS,
  DEFAULT_CONTEXT_MAX_SMALL_DOCUMENTS,
  DEFAULT_CONTEXT_MAX_TOTAL_CHARS,
  DEFAULT_CONTEXT_MAX_TOTAL_CHUNKS,
  DEFAULT_CONTEXT_MAX_WINDOW_CHARS,
  DEFAULT_CONTEXT_MIN_CHARS,
  DEFAULT_CONTEXT_SMALL_DOCUMENT_CHARS,
  DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS,
  DEFAULT_FUSION_LIMIT,
  DEFAULT_RERANK_TOP_N,
  DEFAULT_RRF_K,
  DEFAULT_VECTOR_TOP_K,
} from "./constants";
export {
  asPrimaryCandidate,
  buildEmptyContextAssemblyMetadata,
  countChars,
  createAssemblyAccumulator,
  documentKey,
  ensurePrimaryChunkIncluded,
  isSmallDocumentStats,
  toContextCandidate,
  trimContextWindowToChars,
} from "./context-assembly";
export type { RetrievalPipelineStage } from "./pipeline-contracts";
export { runPipeline } from "./pipeline-runner";
export { buildCitationMetadata, reciprocalRankFusion } from "./ranking";
export { planRetrievalStrategy } from "./planner";
export { rerankCandidates, type RerankGateway } from "./rerank";
export {
  buildRetrievalToolDescription,
  formatRetrievalContext,
  type RetrievalChunk,
} from "./tool-format";
export type {
  ContextAssemblyMetadata,
  EmbeddingVectorStrategy,
  RetrievalCandidate,
  RetrievalCandidateStage,
  RetrievalContextRole,
  RetrievalDocumentChunk,
  RetrievalDocumentChunkStats,
  RetrievalPlannerResult,
} from "./types";
export { createRetrievalTool } from "./tool-runtime";
export {
  type EmbeddingProfile,
  type RetrievalDataAccess,
  type RetrievalEmbeddingGateway,
  type SourceChunkEmbedding,
} from "./data-access";
export { createRetrievalPipeline } from "./pipeline/builder";
export { runRetrieval } from "./run-retrieval";
export { createInitialRetrievalState, requirePreparedRetrievalState } from "./pipeline/state";
export type {
  RetrievalInput,
  RetrievalPipelineState,
  PreparedRetrievalPipelineState,
} from "./pipeline/types";
