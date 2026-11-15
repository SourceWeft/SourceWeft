import type {
  StudyContent,
  StudyDifficulty,
  StudyErrorCode,
  StudyInputs,
  StudyKind,
  StudyOptions,
} from "@sourceweft/contracts/study";

/**
 * The engine is pure: it never touches a database or a model gateway. The host
 * hands it the corpus and implements these ports.
 */

export type StudyOperation =
  | "study.flashcards.generate"
  | "study.flashcards.verify"
  | "study.quiz.generate"
  | "study.quiz.verify"
  | "study.mindmap.generate";

export interface StudyModelPort {
  /**
   * One structured-output call on the default chat model, billed to the person
   * who asked. The host never substitutes another model: an unusable default
   * fails with `MODEL_UNAVAILABLE`, refused admission with
   * `INSUFFICIENT_CREDITS` (both as `StudyGenerationError`).
   */
  completeStructured(input: {
    operation: StudyOperation;
    idempotencyKey: string;
    referenceId: string;
    system: string;
    user: string;
    schema: { name: string; description: string; schema: Record<string, unknown> };
    maxTokens: number;
  }): Promise<unknown>;
}

export type StudyAnchorRequest = {
  /** The generated text that should be supported by the chunk. */
  text: string;
  chunkId: string;
  chunkContent: string;
};

export type StudyAnchorResult = {
  /** Range inside `chunkContent`. */
  startChar: number;
  endChar: number;
  /** `chunkContent.slice(startChar, endChar)`. */
  quote: string;
  /** 0..1 */
  confidence: number;
};

export interface StudyAnchorPort {
  /**
   * Anchors many claims at once (one result per request, in order; null when
   * the chunk does not support the text), so a host can batch any second pass
   * by meaning into one call.
   */
  anchor(
    requests: readonly StudyAnchorRequest[],
  ): Promise<(StudyAnchorResult | null)[]>;
}

/** A chunk as the host loads it. */
export type CorpusChunkInput = {
  chunkId: string;
  sourceId: string;
  documentId: string;
  chunkNo: number;
  headingPath: string | null;
  language: string | null;
  text: string;
};

/** A chunk inside the prompt, addressed by its short `handle` ("c12"). */
export type CorpusChunk = CorpusChunkInput & {
  handle: string;
  tokens: number;
};

export type StudyProgress = {
  stage: "assemble" | "generate" | "verify" | "finalize";
  done: number;
  total: number;
};

export type ResolvedStudyOptions = {
  /** Items to keep (mind maps: most nodes below the root). */
  count: number;
  difficulty: StudyDifficulty;
  /** BCP 47 tag of the output. */
  language: string;
};

/** A generated item before validation; `refs` are corpus handles. */
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

/** Saved after every finished group so a retried job does not pay twice. */
export type StudyCheckpoint = {
  versionNo: number;
  groups: Record<string, GroupResult>;
  /** Verification verdicts by item id: true = kept. */
  verified: Record<string, { keep: boolean; reason?: string }>;
};

export interface StudyCheckpointStore {
  load(): Promise<StudyCheckpoint | null>;
  save(checkpoint: StudyCheckpoint): Promise<void>;
}

export type GenerateStudyInput = {
  kind: StudyKind;
  artifactId: string;
  versionNo: number;
  chunks: readonly CorpusChunkInput[];
  options: ResolvedStudyOptions;
  /** The user's own instruction; never source text. */
  focus?: string;
  /** The recipe stored with the version, for "adjust and regenerate". */
  recipe: { options: StudyOptions; focus?: string; sourceIds: string[] };
  inputs: StudyInputs;
  modelAlias: string;
  /** Mind map root when several groups each yield a branch. */
  rootLabel: string;
  /** Previous version's items: fingerprint → id, so unchanged items keep ids. */
  previousIds?: ReadonlyMap<string, string>;
};

export type StudyGenerationStats = StudyContent["generation"]["stats"];

export type StudyContentResult = {
  content: StudyContent;
  stats: StudyGenerationStats;
  mode: "single" | "mapreduce";
};

export class StudyGenerationError extends Error {
  readonly code: StudyErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: StudyErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StudyGenerationError";
    this.code = code;
    this.details = details;
  }
}

export function isStudyGenerationError(
  error: unknown,
): error is StudyGenerationError {
  return error instanceof StudyGenerationError;
}
