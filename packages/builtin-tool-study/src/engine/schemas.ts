import { z } from "zod";
import type { StudyKind } from "@sourceweft/contracts/study";

/**
 * What the model is asked to return, as strict JSON Schema: every object
 * closed and fully required, optional values as `null` unions, no `$ref` (so a
 * mind map comes back as a flat node list the engine turns into a tree).
 * Bounds the strict mode cannot carry are enforced on the Zod side.
 *
 * Items cite the corpus by handle (`refs: ["c12"]`), never by quoting it; the
 * quote is found in the source by the host's anchoring.
 */

const refsSchema = {
  type: "array",
  description:
    "Handles of the 1 to 3 chunks (for example \"c12\") whose text supports this item.",
  items: { type: "string" },
} as const;

const quoteSchema = {
  type: ["string", "null"],
  description:
    "A passage copied word for word from one of the cited chunks, in that chunk's own language (at most 200 characters), that states the supporting fact. Never translated or reworded; null only when no single passage states it.",
} as const;

const difficultySchema = {
  type: "integer",
  enum: [1, 2, 3],
  description: "1 recall, 2 understanding, 3 application or analysis.",
} as const;

const nullableString = (description: string) =>
  ({ type: ["string", "null"], description }) as const;

export const FLASHCARDS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["front", "back", "hint", "tags", "difficulty", "refs", "quote"],
        properties: {
          front: {
            type: "string",
            description: "A question or term. Never contains the answer.",
          },
          back: { type: "string", description: "The answer, from the sources." },
          hint: nullableString("An optional hint that does not give the answer away."),
          tags: {
            type: "array",
            description: "Up to 3 short topic tags.",
            items: { type: "string" },
          },
          difficulty: difficultySchema,
          refs: refsSchema,
          quote: quoteSchema,
        },
      },
    },
  },
} as const;

export const QUIZ_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "stem",
          "options",
          "correct",
          "referenceAnswer",
          "explanation",
          "difficulty",
          "refs",
          "quote",
        ],
        properties: {
          type: { type: "string", enum: ["single", "multi", "truefalse", "short"] },
          stem: { type: "string", description: "The question." },
          options: {
            type: "array",
            description:
              'Answer options: 3 to 5 for single/multi, exactly ["true","false"] for truefalse, empty for short.',
            items: { type: "string" },
          },
          correct: {
            type: "array",
            description: "Zero-based indices of the correct options; empty for short.",
            items: { type: "integer" },
          },
          referenceAnswer: nullableString("The model answer of a short question; null otherwise."),
          explanation: {
            type: "string",
            description: "Why the answer is right, based on the sources.",
          },
          difficulty: difficultySchema,
          refs: refsSchema,
          quote: quoteSchema,
        },
      },
    },
  },
} as const;

export const MINDMAP_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rootLabel", "rootSummary", "nodes"],
  properties: {
    rootLabel: { type: "string", description: "The central topic, at most 40 characters." },
    rootSummary: nullableString("One sentence about the whole, or null."),
    nodes: {
      type: "array",
      description: "Every node below the root, parents before their children.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "parentKey", "label", "summary", "refs", "quote"],
        properties: {
          key: { type: "string", description: "A short unique key such as \"n1\"." },
          parentKey: nullableString("The parent's key; null for a child of the root."),
          label: { type: "string", description: "At most 40 characters." },
          summary: nullableString("One sentence of at most 200 characters, or null."),
          refs: refsSchema,
          quote: quoteSchema,
        },
      },
    },
  },
} as const;

export const OPTION_VERDICTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["determinable", "verdicts"],
  properties: {
    determinable: {
      type: "boolean",
      description: "False when the text alone cannot settle the answer.",
    },
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["option", "supported"],
        properties: {
          option: { type: "integer", description: "Zero-based option index." },
          supported: {
            type: "boolean",
            description: "Whether the text supports this option as a correct answer.",
          },
        },
      },
    },
  },
} as const;

export const SUPPORT_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supported"],
  properties: {
    supported: {
      type: "boolean",
      description: "Whether the text alone fully supports the answer.",
    },
  },
} as const;

export const GENERATION_SCHEMAS: Record<
  StudyKind,
  { name: string; description: string; schema: Record<string, unknown> }
> = {
  flashcards: {
    name: "study_flashcards",
    description: "Flashcards drawn from the given source chunks.",
    schema: FLASHCARDS_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  },
  quiz: {
    name: "study_quiz",
    description: "Quiz questions drawn from the given source chunks.",
    schema: QUIZ_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  },
  mindmap: {
    name: "study_mindmap",
    description: "A mind map of the given source chunks as a flat node list.",
    schema: MINDMAP_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  },
};

export const VERIFY_SCHEMAS = {
  options: {
    name: "study_option_verdicts",
    description: "Whether the text supports each option.",
    schema: OPTION_VERDICTS_SCHEMA as unknown as Record<string, unknown>,
  },
  support: {
    name: "study_support_verdict",
    description: "Whether the text supports the answer.",
    schema: SUPPORT_VERDICT_SCHEMA as unknown as Record<string, unknown>,
  },
};

/* Zod readers of the model's answer. Top level strict-ish, items lenient so
 * one bad item is dropped and counted instead of failing the whole group. */

const looseArray = z.array(z.unknown());

export const flashcardsOutputReader = z.object({ cards: looseArray });
export const quizOutputReader = z.object({ questions: looseArray });
export const mindmapOutputReader = z.object({
  rootLabel: z.string(),
  rootSummary: z.string().nullable().optional(),
  nodes: looseArray,
});

const text = z.string().transform((value) => value.trim());
const refs = z.array(z.string()).default([]);
const quote = z.string().nullable().optional();
const difficulty = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const rawFlashcardReader = z.object({
  front: text.pipe(z.string().min(1)),
  back: text.pipe(z.string().min(1)),
  hint: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  difficulty,
  refs,
  quote,
});
export type RawFlashcard = z.infer<typeof rawFlashcardReader>;

export const rawQuizReader = z.object({
  type: z.enum(["single", "multi", "truefalse", "short"]),
  stem: text.pipe(z.string().min(1)),
  options: z.array(z.string()).default([]),
  correct: z.array(z.number().int()).default([]),
  referenceAnswer: z.string().nullable().optional(),
  explanation: text.pipe(z.string().min(1)),
  difficulty,
  refs,
  quote,
});
export type RawQuiz = z.infer<typeof rawQuizReader>;

export const rawMindmapNodeReader = z.object({
  key: text.pipe(z.string().min(1)),
  parentKey: z.string().nullable().optional(),
  label: text.pipe(z.string().min(1)),
  summary: z.string().nullable().optional(),
  refs,
  quote,
});
export type RawMindmapNode = z.infer<typeof rawMindmapNodeReader>;

export const optionVerdictsReader = z.object({
  determinable: z.boolean(),
  verdicts: z.array(
    z.object({ option: z.number().int(), supported: z.boolean() }),
  ),
});

export const supportVerdictReader = z.object({ supported: z.boolean() });
