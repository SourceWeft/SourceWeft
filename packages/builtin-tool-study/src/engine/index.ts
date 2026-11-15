/**
 * The study generation engine: pure logic behind ports, for the backend only.
 * It imports `node:crypto`, so it must never be reached from a browser graph.
 */
export * from "./constants";
export {
  allocateGroupQuotas,
  assembleCorpus,
  estimateTokens,
  groupCorpus,
  StudyInputTooLargeError,
} from "./corpus";
export {
  generateStudyContent,
  generationIdempotencyKey,
  judgeOptionVerdicts,
  studyReferenceId,
  verifyIdempotencyKey,
  type GenerateStudyDeps,
} from "./generate";
export { resolveOutputLanguage } from "./language";
export { resolveStudyOptions } from "./options";
export {
  isStudyGenerationError,
  StudyGenerationError,
  type CorpusChunk,
  type CorpusChunkInput,
  type GenerateStudyInput,
  type ResolvedStudyOptions,
  type StudyAnchorPort,
  type StudyAnchorRequest,
  type StudyAnchorResult,
  type StudyCheckpoint,
  type StudyCheckpointStore,
  type StudyContentResult,
  type StudyModelPort,
  type StudyOperation,
  type StudyProgress,
} from "./types";
