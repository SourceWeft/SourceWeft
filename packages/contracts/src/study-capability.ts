import {
  GroundedGenerationError,
  isGroundedGenerationError,
  type GroundedAnchorPort,
  type GroundedAnchorRequest,
  type GroundedAnchorResult,
  type GroundedCheckpointStore,
  type GroundedCorpusChunk,
  type GroundedModelPort,
} from "./grounded-generation";
import {
  type StudyContent,
  type StudyDifficulty,
  type StudyInputs,
  type StudyKind,
  type StudyOptions,
} from "./study";

/**
 * The host ↔ study capability contract.
 *
 * The backend never imports `@sourceweft/builtin-tool-study`. It loads the
 * package's entry module through `@sourceweft/agent-tool-registry/server`, calls
 * the `createStudyCapability` factory and narrows the result with
 * `readStudyCapability`. The shapes both sides agree on live here, beside the
 * study content contract they are built from (`./study`); they are types plus
 * one pure error class, so nothing here pulls server code into a browser graph.
 *
 * The module is a set of optional groups. Each host that needs a group asks
 * for it by name and fails loudly if it is missing; a new group (for example
 * review scheduling) is added beside the others without reshaping them.
 */

/* ------------------------------------------------------------------ errors */

/**
 * The generation error and its structural check now live in
 * `./grounded-generation`; these are the same class and function under the
 * names study code has always used.
 */
export const StudyGenerationError = GroundedGenerationError;
export type StudyGenerationError = GroundedGenerationError;
export const isStudyGenerationError = isGroundedGenerationError;

/* ------------------------------------------------------------------- ports */

export type StudyOperation =
  | "study.flashcards.generate"
  | "study.flashcards.verify"
  | "study.quiz.generate"
  | "study.quiz.verify"
  | "study.mindmap.generate";

/** One structured-output call on the default chat model, billed by the host. */
export type StudyModelPort = GroundedModelPort<StudyOperation>;

export type StudyAnchorRequest = GroundedAnchorRequest;
export type StudyAnchorResult = GroundedAnchorResult;

/** Finds where generated text is supported in its cited chunk. */
export type StudyAnchorPort = GroundedAnchorPort;

/**
 * The engine's resume state. The host stores it as JSON and hands it back
 * unchanged; only the engine reads `groups`.
 */
export type StudyCheckpointData = {
  versionNo: number;
  groups: Record<string, unknown>;
  verified: Record<string, { keep: boolean; reason?: string }>;
};

export type StudyCheckpointStore = GroundedCheckpointStore<StudyCheckpointData>;

export type StudyProgress = {
  stage: "assemble" | "generate" | "verify" | "finalize";
  done: number;
  total: number;
};

/* ------------------------------------------------------------- generation */

/** A chunk as the host loads it. */
export type StudyCorpusChunk = GroundedCorpusChunk;

export type ResolvedStudyOptions = {
  /** Items to keep (mind maps: most nodes below the root). */
  count: number;
  difficulty: StudyDifficulty;
  /** BCP 47 tag of the output. */
  language: string;
};

export type GenerateStudyInput = {
  kind: StudyKind;
  artifactId: string;
  versionNo: number;
  chunks: readonly StudyCorpusChunk[];
  options: ResolvedStudyOptions;
  /** The user's own instruction; never source text. */
  focus?: string;
  /** Stored with the version for "adjust and regenerate". */
  recipe: { options: StudyOptions; focus?: string; sourceIds: string[] };
  inputs: StudyInputs;
  modelAlias: string;
  /** Mind map root when several groups each yield a branch. */
  rootLabel: string;
  /** Previous version's items: fingerprint → id, so unchanged items keep ids. */
  previousIds?: ReadonlyMap<string, string>;
};

export type GenerateStudyDeps = {
  model: StudyModelPort;
  anchor: StudyAnchorPort;
  onProgress?(progress: StudyProgress): void | Promise<void>;
  checkpoint?: StudyCheckpointStore;
  signal?: AbortSignal;
};

export type StudyGenerationStats = StudyContent["generation"]["stats"];

export type StudyContentResult = {
  content: StudyContent;
  stats: StudyGenerationStats;
  mode: "single" | "mapreduce";
};

/** How a corpus would be generated, without any model call. */
export type StudyCorpusMeasure = {
  totalTokens: number;
  mode: "single" | "mapreduce";
  /** 0 when the corpus exceeds the limit. */
  groups: number;
  exceedsLimit: boolean;
};

export type StudyGenerationMembers = {
  generateStudyContent(
    deps: GenerateStudyDeps,
    input: GenerateStudyInput,
  ): Promise<StudyContentResult>;
  resolveStudyOptions(input: {
    kind: StudyKind;
    options?: StudyOptions;
    chunks: readonly Pick<StudyCorpusChunk, "language" | "text">[];
    uiLocale: string;
  }): ResolvedStudyOptions;
  measureCorpus(chunks: readonly StudyCorpusChunk[]): StudyCorpusMeasure;
  estimateTokens(text: string): number;
  limits: {
    singlePassMaxInputTokens: number;
    maxTotalInputTokens: number;
    /** Wall-clock budget of one generation job, by mode. */
    jobTimeoutMs: { single: number; mapreduce: number };
  };
};

/* ------------------------------------------------------------- scheduling */

export type StudyReviewGrade = 1 | 2 | 3 | 4;
export type StudyReviewCardState = 0 | 1 | 2 | 3;

/** One card's FSRS schedule; the fields map one-to-one onto `study_review_states`. */
export type StudyReviewCard = {
  /** 0 New, 1 Learning, 2 Review, 3 Relearning. */
  state: StudyReviewCardState;
  dueAt: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastReviewedAt: Date | null;
};

/** One grade as it lands in `study_review_logs`: the card as it was before. */
export type StudyReviewLogEntry = {
  grade: StudyReviewGrade;
  stateBefore: StudyReviewCardState;
  dueBefore: Date;
  stabilityBefore: number;
  difficultyBefore: number;
  elapsedDays: number;
  scheduledDays: number;
  reviewedAt: Date;
};

/** Spaced-repetition scheduling (FSRS). Pure and deterministic. */
export type StudySchedulingMembers = {
  /** Applies one grade at `now`; `card` is null for an item never graded. */
  scheduleReview(
    card: StudyReviewCard | null,
    grade: StudyReviewGrade,
    now: Date,
    options?: { desiredRetention?: number },
  ): { state: StudyReviewCard; log: StudyReviewLogEntry };
  newReviewCard(now: Date): StudyReviewCard;
  /** The recall rate the schedule targets by default. */
  desiredRetention: number;
};

/* ------------------------------------------------------------- derivation */

/** Model-free study content built from other study content. */
export type StudyDerivationMembers = {
  /** Chosen quiz questions as a new flashcards content, in quiz order. */
  deriveFlashcardsFromQuiz(
    content: Extract<StudyContent, { kind: "quiz" }>,
    itemIds: readonly string[],
    options?: { trueFalseLabels?: { true: string; false: string } },
  ): Extract<StudyContent, { kind: "flashcards" }>;
};

/* ------------------------------------------------------------------ module */

/**
 * Everything the study capability offers a host. Groups are optional so each
 * can ship on its own; a host requires the ones it uses.
 */
export type StudyCapabilityModule = {
  generation?: StudyGenerationMembers;
  scheduling?: StudySchedulingMembers;
  derivation?: StudyDerivationMembers;
};

/** Name of the entry-module factory that builds the module. */
export const STUDY_CAPABILITY_FACTORY = "createStudyCapability";

export type CreateStudyCapability = () => StudyCapabilityModule;

/** The capability is not deployed as this host expects. Never retried away. */
export class StudyCapabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudyCapabilityUnavailableError";
  }
}

const REQUIRED_MEMBERS: {
  [Group in keyof Required<StudyCapabilityModule>]: readonly string[];
} = {
  generation: [
    "generateStudyContent",
    "resolveStudyOptions",
    "measureCorpus",
    "estimateTokens",
    "limits",
  ],
  scheduling: ["scheduleReview", "newReviewCard", "desiredRetention"],
  derivation: ["deriveFlashcardsFromQuiz"],
};

/**
 * Narrows a loaded entry module to the study capability. With `require`, the
 * named groups must be present with every member, or this throws
 * `StudyCapabilityUnavailableError` naming what is missing.
 */
export function readStudyCapability(
  entryModule: Record<string, unknown> | null | undefined,
  ...require: (keyof StudyCapabilityModule)[]
): StudyCapabilityModule {
  const factory = entryModule?.[STUDY_CAPABILITY_FACTORY];
  if (typeof factory !== "function") {
    throw new StudyCapabilityUnavailableError(
      `The study capability entry module does not export ${STUDY_CAPABILITY_FACTORY}()`,
    );
  }
  const capability = (factory as CreateStudyCapability)();
  if (!capability || typeof capability !== "object") {
    throw new StudyCapabilityUnavailableError(
      `${STUDY_CAPABILITY_FACTORY}() did not return a study capability module`,
    );
  }
  for (const group of require) {
    const members = capability[group] as Record<string, unknown> | undefined;
    if (!members || typeof members !== "object") {
      throw new StudyCapabilityUnavailableError(
        `The study capability does not provide its "${group}" members`,
      );
    }
    const missing = REQUIRED_MEMBERS[group].filter(
      (name) => members[name] === undefined,
    );
    if (missing.length > 0) {
      throw new StudyCapabilityUnavailableError(
        `The study capability's "${group}" members lack ${missing.join(", ")}`,
      );
    }
  }
  return capability;
}
