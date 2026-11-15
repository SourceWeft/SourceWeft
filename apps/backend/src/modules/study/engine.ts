/**
 * The one place the backend reaches the study capability's generation engine.
 *
 * The engine is pure logic behind ports (`StudyModelPort`, `StudyAnchorPort`);
 * this module implements the ports and does the I/O around it. Everything in
 * `modules/study` imports the engine from here, so the capability import is a
 * single, listed exemption of the host↔capability boundary guard
 * (`architecture-capability-imports.test.ts`) rather than one per file.
 */
export {
  generateStudyContent,
  isStudyGenerationError,
  resolveStudyOptions,
  STUDY_JOB_ATTEMPTS,
  STUDY_JOB_TIMEOUT_MS,
  SINGLE_PASS_MAX_INPUT_TOKENS,
  estimateTokens,
  StudyGenerationError,
  type CorpusChunkInput,
  type StudyAnchorPort,
  type StudyAnchorRequest,
  type StudyAnchorResult,
  type StudyCheckpoint,
  type StudyCheckpointStore,
  type StudyContentResult,
  type StudyModelPort,
  type StudyProgress,
} from "@sourceweft/builtin-tool-study/engine";
