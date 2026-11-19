import type { StudyCheckpointData } from "@sourceweft/contracts/study-capability";

/**
 * The engine is pure: it never touches a database or a model gateway. The host
 * hands it the corpus and implements the ports. The shapes the host shares
 * with the engine are the study capability contract
 * (`@sourceweft/contracts/study-capability`); this file adds the engine's own
 * working types.
 */
export {
  isStudyGenerationError,
  StudyGenerationError,
  type GenerateStudyDeps,
  type GenerateStudyInput,
  type ResolvedStudyOptions,
  type StudyAnchorPort,
  type StudyAnchorRequest,
  type StudyAnchorResult,
  type StudyCheckpointStore,
  type StudyContentResult,
  type StudyCorpusChunk as CorpusChunkInput,
  type StudyGenerationStats,
  type StudyModelPort,
  type StudyOperation,
  type StudyProgress,
} from "@sourceweft/contracts/study-capability";
export type { CorpusChunk } from "@sourceweft/grounded-generation";

export type FlashcardCandidate = {
  kind: "flashcards";
  id: string;
  fingerprint: string;
  front: string;
  back: string;
  hint: string | null;
  tags: string[];
  difficulty: 1 | 2 | 3;
  refs: string[];
};

export type QuizCandidate = {
  kind: "quiz";
  id: string;
  fingerprint: string;
  type: "single" | "multi" | "truefalse" | "short";
  stem: string;
  options: string[];
  correct: number[];
  referenceAnswer: string | null;
  explanation: string;
  difficulty: 1 | 2 | 3;
  refs: string[];
};

export type MindmapCandidate = {
  kind: "mindmap";
  id: string;
  fingerprint: string;
  /** The model's own key, unique within its group. */
  key: string;
  /** Null: a child of the group's root. */
  parentKey: string | null;
  label: string;
  summary: string | null;
  refs: string[];
};

export type MindmapGroupCandidate = {
  rootLabel: string;
  rootSummary: string | null;
  nodes: MindmapCandidate[];
};

export type GroupResult =
  | { kind: "flashcards"; items: FlashcardCandidate[]; dropped: DropCounts }
  | { kind: "quiz"; items: QuizCandidate[]; dropped: DropCounts }
  | { kind: "mindmap"; tree: MindmapGroupCandidate; dropped: DropCounts };

export type DropCounts = Record<string, number>;

/** The checkpoint as the engine reads it; the host stores it as opaque JSON. */
export type StudyCheckpoint = StudyCheckpointData & {
  groups: Record<string, GroupResult>;
};
