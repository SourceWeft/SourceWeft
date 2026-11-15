import { z } from "zod";
import { sha256Hex } from "./sha256";

/**
 * Learning artifacts: flashcards, quizzes and mind maps generated from sources.
 *
 * The generated content is stored as an ordinary artifact payload, so these
 * schemas describe `artifact_versions.content_json`. Per-user learning state
 * (spaced-repetition schedule, review log, quiz attempts) lives in its own
 * tables and refers to items only by their stable `id`.
 *
 * Item ids are minted once with `newStudyItemId` and never change. The
 * `fingerprint` is a hash of the item's normalized text, used only when a
 * version is regenerated to hand an old id to an unchanged item, so learning
 * progress survives regeneration.
 */

export const STUDY_ARTIFACT_TYPES = ["flashcards", "quiz", "mindmap"] as const;
export const studyArtifactTypeSchema = z.enum(STUDY_ARTIFACT_TYPES);
export type StudyArtifactType = z.infer<typeof studyArtifactTypeSchema>;
/** The `kind` discriminator of content equals the artifact type. */
export type StudyKind = StudyArtifactType;

export const STUDY_LIMITS = {
  maxSources: 50,
  /** Highest item count a request may ask for, per artifact type. */
  maxCount: { flashcards: 60, quiz: 30, mindmap: 80 },
  focusChars: 200,
  quoteChars: 600,
  evidencePerItem: 3,
  optionsMin: 2,
  optionsMax: 6,
  mindmapLabelChars: 40,
  mindmapSummaryChars: 200,
  /** Levels below the root. */
  mindmapMaxDepth: 4,
  mindmapMaxFanout: 8,
  mindmapMaxNodes: 80,
} as const satisfies Record<string, unknown>;

/** Serialized size ceiling of one study payload (artifact content). */
export const STUDY_PAYLOAD_MAX_BYTES = 512 * 1024;

export const STUDY_SCHEMA_VERSION = 1;

/** The two fixed options of a true/false question; labels are localized by the viewer. */
export const STUDY_TRUEFALSE_OPTIONS = ["true", "false"] as const;

const isoTimestampSchema = z.iso.datetime();
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{16}$/);
const idBody = "[A-Za-z0-9_-]{1,64}";
const flashcardIdSchema = z.string().regex(new RegExp(`^c_${idBody}$`));
const quizItemIdSchema = z.string().regex(new RegExp(`^q_${idBody}$`));
const mindmapNodeIdSchema = z.string().regex(new RegExp(`^n_${idBody}$`));

/** Where a generated item came from; the quote is source text, not model output. */
export const studyEvidenceSchema = z
  .object({
    kind: z.literal("chunk"),
    sourceId: z.string().min(1),
    documentId: z.string().min(1),
    chunkId: z.string().min(1),
    chunkNo: z.number().int().nonnegative().optional(),
    headingPath: z.string().nullable().optional(),
    quote: z.string().min(1).max(STUDY_LIMITS.quoteChars),
    /** Range of the quote inside the chunk, once anchored. */
    startChar: z.number().int().nonnegative().optional(),
    endChar: z.number().int().nonnegative().optional(),
    /** `sha256:` of `quote`; tells a viewer whether the source text moved. */
    quoteHash: sha256DigestSchema,
  })
  .refine(
    (value) =>
      value.startChar === undefined ||
      value.endChar === undefined ||
      value.endChar >= value.startChar,
    { message: "endChar must not precede startChar", path: ["endChar"] },
  );
export type StudyEvidence = z.infer<typeof studyEvidenceSchema>;

const difficultySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const evidenceListSchema = z
  .array(studyEvidenceSchema)
  .min(1)
  .max(STUDY_LIMITS.evidencePerItem);

export const flashcardItemSchema = z.object({
  id: flashcardIdSchema,
  fingerprint: fingerprintSchema,
  front: z.string().min(1).max(1000),
  back: z.string().min(1).max(2000),
  hint: z.string().max(500).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(8),
  difficulty: difficultySchema,
  evidence: evidenceListSchema,
});
export type FlashcardItem = z.infer<typeof flashcardItemSchema>;

export const QUIZ_QUESTION_TYPES = [
  "single",
  "multi",
  "truefalse",
  "short",
] as const;
export const quizQuestionTypeSchema = z.enum(QUIZ_QUESTION_TYPES);
export type QuizQuestionType = z.infer<typeof quizQuestionTypeSchema>;

export const quizItemSchema = z
  .object({
    id: quizItemIdSchema,
    fingerprint: fingerprintSchema,
    type: quizQuestionTypeSchema,
    stem: z.string().min(1).max(1000),
    options: z.array(z.string().min(1).max(500)).optional(),
    correct: z.array(z.number().int()).optional(),
    referenceAnswer: z.string().min(1).max(2000).optional(),
    explanation: z.string().min(1).max(2000),
    difficulty: difficultySchema,
    evidence: evidenceListSchema,
  })
  .superRefine((item, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (item.type === "short") {
      if (item.options !== undefined) fail("options", "short has no options");
      if (item.correct !== undefined) fail("correct", "short has no correct");
      if (item.referenceAnswer === undefined) {
        fail("referenceAnswer", "short needs a referenceAnswer");
      }
      return;
    }

    const { options, correct } = item;
    if (options === undefined || correct === undefined) {
      fail("options", `${item.type} needs options and correct`);
      return;
    }
    if (item.type === "truefalse") {
      const fixed =
        options.length === STUDY_TRUEFALSE_OPTIONS.length &&
        options.every((option, i) => option === STUDY_TRUEFALSE_OPTIONS[i]);
      if (!fixed) fail("options", 'truefalse options must be ["true","false"]');
    } else if (
      options.length < STUDY_LIMITS.optionsMin ||
      options.length > STUDY_LIMITS.optionsMax
    ) {
      fail(
        "options",
        `options must hold ${STUDY_LIMITS.optionsMin}-${STUDY_LIMITS.optionsMax} entries`,
      );
    }
    if (item.type !== "multi" && correct.length !== 1) {
      fail("correct", `${item.type} needs exactly one correct option`);
    } else if (correct.length < 1) {
      fail("correct", "at least one correct option is required");
    }
    if (new Set(correct).size !== correct.length) {
      fail("correct", "correct indices must be unique");
    }
    if (correct.some((index) => index < 0 || index >= options.length)) {
      fail("correct", "correct index is outside the options");
    }
  });
export type QuizItem = z.infer<typeof quizItemSchema>;

export type MindmapNode = {
  id: string;
  fingerprint: string;
  label: string;
  summary?: string | null;
  children: MindmapNode[];
  evidence: StudyEvidence[];
};

/**
 * Built level by level rather than with `z.lazy`, so depth and fan-out are
 * structural: a payload nested deeper than the limit fails without recursion.
 */
function mindmapNodeLevel(levelsBelow: number): z.ZodType<MindmapNode> {
  const children: z.ZodType<MindmapNode[]> =
    levelsBelow === 0
      ? z.array(z.never()).max(0)
      : z
          .array(mindmapNodeLevel(levelsBelow - 1))
          .max(STUDY_LIMITS.mindmapMaxFanout);
  return z.object({
    id: mindmapNodeIdSchema,
    fingerprint: fingerprintSchema,
    label: z.string().min(1).max(STUDY_LIMITS.mindmapLabelChars),
    summary: z.string().max(STUDY_LIMITS.mindmapSummaryChars).nullable().optional(),
    children,
    evidence: z.array(studyEvidenceSchema).max(STUDY_LIMITS.evidencePerItem),
  }) as z.ZodType<MindmapNode>;
}

export const mindmapNodeSchema = mindmapNodeLevel(
  STUDY_LIMITS.mindmapMaxDepth,
);

export const studyInputsSchema = z.object({
  selection: z.enum(["sources", "folder"]),
  sources: z
    .array(
      z.object({
        sourceId: z.string().min(1),
        documentId: z.string().min(1),
        /** `sources.content_hash` when generated; compared later for staleness. */
        contentHash: z.string().min(1),
      }),
    )
    .min(1)
    .max(STUDY_LIMITS.maxSources),
});
export type StudyInputs = z.infer<typeof studyInputsSchema>;

export const STUDY_SIZES = ["fewer", "standard", "more"] as const;
export const studySizeSchema = z.enum(STUDY_SIZES);
export type StudySize = z.infer<typeof studySizeSchema>;

export const STUDY_DIFFICULTIES = ["easy", "mixed", "hard"] as const;
export const studyDifficultySchema = z.enum(STUDY_DIFFICULTIES);
export type StudyDifficulty = z.infer<typeof studyDifficultySchema>;

export const studyOptionsSchema = z.object({
  size: studySizeSchema.optional(),
  /** Exact item count; the per-type ceiling is checked with the artifact type. */
  count: z.number().int().min(1).max(STUDY_LIMITS.maxCount.mindmap).optional(),
  difficulty: studyDifficultySchema.optional(),
  /** BCP 47 tag; omitted means follow the sources. */
  language: z.string().min(2).max(35).optional(),
  /** The user's own instruction about what to emphasize; never source text. */
  focus: z.string().max(STUDY_LIMITS.focusChars).optional(),
});
export type StudyOptions = z.infer<typeof studyOptionsSchema>;

export const studyVisibilitySchema = z.enum(["private", "workspace"]);

/** The recipe is what "adjust and regenerate" pre-fills the dialog from. */
export const studyGenerationMetaSchema = z.object({
  promptVersion: z.string().min(1),
  modelAlias: z.string().min(1),
  mode: z.enum(["single", "mapreduce"]),
  stats: z.object({
    requested: z.number().int().nonnegative(),
    kept: z.number().int().nonnegative(),
    dropped: z.record(z.string(), z.number().int().nonnegative()),
    groups: z.number().int().nonnegative(),
    tokensEstimated: z.number().int().nonnegative(),
    difficultySkew: z.boolean().optional(),
  }),
  recipe: z.object({
    options: studyOptionsSchema,
    focus: z.string().max(STUDY_LIMITS.focusChars).optional(),
    sourceIds: z.array(z.string().min(1)).min(1).max(STUDY_LIMITS.maxSources),
  }),
});
export type StudyGenerationMeta = z.infer<typeof studyGenerationMetaSchema>;

const contentBase = {
  schemaVersion: z.literal(STUDY_SCHEMA_VERSION),
  language: z.string().min(2).max(35),
  inputs: studyInputsSchema,
  generation: studyGenerationMetaSchema,
};

function addDuplicateIdIssues(
  ids: readonly string[],
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      ctx.addIssue({ code: "custom", path, message: `duplicate item id ${id}` });
      return;
    }
    seen.add(id);
  }
}

function flattenMindmap(root: MindmapNode): MindmapNode[] {
  const nodes: MindmapNode[] = [];
  const stack = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    nodes.push(node);
    stack.push(...node.children);
  }
  return nodes;
}

export const studyContentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...contentBase,
      kind: z.literal("flashcards"),
      items: z.array(flashcardItemSchema).min(1).max(STUDY_LIMITS.maxCount.flashcards),
    })
    .superRefine((value, ctx) =>
      addDuplicateIdIssues(
        value.items.map((item) => item.id),
        ctx,
        ["items"],
      ),
    ),
  z
    .object({
      ...contentBase,
      kind: z.literal("quiz"),
      items: z.array(quizItemSchema).min(1).max(STUDY_LIMITS.maxCount.quiz),
    })
    .superRefine((value, ctx) =>
      addDuplicateIdIssues(
        value.items.map((item) => item.id),
        ctx,
        ["items"],
      ),
    ),
  z
    .object({
      ...contentBase,
      kind: z.literal("mindmap"),
      root: mindmapNodeSchema,
    })
    .superRefine((value, ctx) => {
      const nodes = flattenMindmap(value.root);
      if (nodes.length > STUDY_LIMITS.mindmapMaxNodes) {
        ctx.addIssue({
          code: "custom",
          path: ["root"],
          message: `a mind map holds at most ${STUDY_LIMITS.mindmapMaxNodes} nodes`,
        });
      }
      addDuplicateIdIssues(
        nodes.map((node) => node.id),
        ctx,
        ["root"],
      );
    }),
]);
export type StudyContent = z.infer<typeof studyContentSchema>;

/**
 * Parses content stored on an artifact of `artifactType`; the `kind` inside the
 * content must agree with the artifact row it came from.
 */
export function parseStudyContentForArtifact(
  artifactType: string,
  value: unknown,
): StudyContent {
  const content = studyContentSchema.parse(value);
  if (content.kind !== artifactType) {
    throw new Error(
      `Study content kind "${content.kind}" does not match artifact type "${artifactType}"`,
    );
  }
  return content;
}

export const studyErrorCodeSchema = z.enum([
  "INSUFFICIENT_CREDITS",
  "INPUT_TOO_LARGE",
  "NO_INDEXED_SOURCES",
  "MODEL_UNAVAILABLE",
  "GENERATION_QUALITY_TOO_LOW",
  "SOURCE_NOT_READABLE",
]);
export type StudyErrorCode = z.infer<typeof studyErrorCodeSchema>;

export const studyGenerateRequestSchema = z
  .object({
    /** Artifacts hang off a thread, so generation is always requested in one. */
    threadId: z.string().min(1),
    artifactType: studyArtifactTypeSchema,
    sourceIds: z.array(z.string().min(1)).min(1).max(STUDY_LIMITS.maxSources),
    options: studyOptionsSchema.optional(),
    visibility: studyVisibilitySchema.optional(),
  })
  .superRefine((request, ctx) => {
    const count = request.options?.count;
    const max = STUDY_LIMITS.maxCount[request.artifactType];
    if (count !== undefined && count > max) {
      ctx.addIssue({
        code: "custom",
        path: ["options", "count"],
        message: `${request.artifactType} accepts at most ${max} items`,
      });
    }
  });
export type StudyGenerateRequest = z.infer<typeof studyGenerateRequestSchema>;

/** Review grades are the FSRS ratings: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export const reviewGradeSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type ReviewGrade = z.infer<typeof reviewGradeSchema>;

/** 0 New, 1 Learning, 2 Review, 3 Relearning. */
export const reviewCardStateSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const reviewStateSchema = z.object({
  itemId: z.string().min(1),
  state: reviewCardStateSchema,
  dueAt: isoTimestampSchema,
  stability: z.number().nonnegative(),
  difficulty: z.number().nonnegative(),
  elapsedDays: z.number().int().nonnegative(),
  scheduledDays: z.number().int().nonnegative(),
  learningSteps: z.number().int().nonnegative(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  lastReviewedAt: isoTimestampSchema.nullable(),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const reviewRequestSchema = z.object({
  versionNo: z.number().int().positive(),
  itemId: z.string().min(1),
  grade: reviewGradeSchema,
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const reviewQueueItemSchema = z.object({
  artifactId: z.string().min(1),
  versionNo: z.number().int().positive(),
  itemId: z.string().min(1),
  state: reviewCardStateSchema,
  dueAt: isoTimestampSchema,
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

/** One answer: chosen option indices, or a self grade for short questions. */
export const quizAnswerSchema = z
  .object({
    selected: z.array(z.number().int().nonnegative()).max(STUDY_LIMITS.optionsMax).optional(),
    text: z.string().max(2000).optional(),
    selfGrade: z.enum(["knew", "missed"]).optional(),
  })
  .strict();
export type QuizAnswer = z.infer<typeof quizAnswerSchema>;

export const submitAnswersSchema = z.object({
  answers: z.record(z.string().min(1), quizAnswerSchema),
  finish: z.boolean().optional(),
});
export type SubmitAnswers = z.infer<typeof submitAnswersSchema>;

export const startQuizAttemptSchema = z.object({
  versionNo: z.number().int().positive(),
  itemIds: z.array(z.string().min(1)).min(1).max(STUDY_LIMITS.maxCount.quiz).optional(),
});
export type StartQuizAttempt = z.infer<typeof startQuizAttemptSchema>;

export const quizAttemptSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  versionNo: z.number().int().positive(),
  itemIds: z.array(z.string().min(1)),
  answers: z.record(z.string(), quizAnswerSchema),
  score: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
});
export type QuizAttempt = z.infer<typeof quizAttemptSchema>;

/** Lower-cases, folds width/compatibility forms, drops punctuation and spaces. */
function normalizeForFingerprint(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
}

/**
 * First 16 hex digits of sha256 over `kind` and the normalized text. Only used
 * on regeneration to find which new item is an old one; it is never an id.
 */
export function studyFingerprint(kind: StudyKind, text: string): string {
  return sha256Hex(`${kind}:${normalizeForFingerprint(text)}`).slice(0, 16);
}

const ID_PREFIX: Record<StudyKind, string> = {
  flashcards: "c",
  quiz: "q",
  mindmap: "n",
};

/** Mints an item id. Call once when the item is created; it never changes. */
export function newStudyItemId(kind: StudyKind): string {
  return `${ID_PREFIX[kind]}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/** Throws when serialized content exceeds `STUDY_PAYLOAD_MAX_BYTES`. */
export function assertStudyPayloadSize(payload: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (bytes > STUDY_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `Study payload too large: ${bytes} bytes exceeds ${STUDY_PAYLOAD_MAX_BYTES / 1024} KB`,
    );
  }
}
