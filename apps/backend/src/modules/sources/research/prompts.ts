import { z } from "zod";
import type { LedgerEntry } from "./ledger";

/**
 * Prompts and JSON schemas for the deep-research loop. Each builder is a plain
 * function returning `{ system, user }`; the schemas are the structured-output
 * shapes the model must answer with. Every prompt tells the model to ground its
 * answer in the supplied page text and to write in the language of the topic.
 */

const bullets = (items: string[]) =>
  items.map((item) => `- ${item}`).join("\n");

/** Trims, de-duplicates (case-insensitively) and caps a list of short strings. */
function distinctTrimmed(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const value = raw.replace(/\s+/g, " ").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/* ------------------------------------------------------------------- plan */

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subquestions"],
  properties: {
    subquestions: {
      type: "array",
      description:
        "Up to 6 distinct sub-questions that, answered together, cover the topic.",
      items: { type: "string" },
    },
  },
} as const;

const planSchema = z.object({ subquestions: z.array(z.string()) });

export function parsePlan(value: unknown, max = 6): string[] {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) return [];
  return distinctTrimmed(parsed.data.subquestions, max);
}

export function buildPlanPrompt(topic: string) {
  return {
    system:
      "You plan a research task. From the topic, list up to 6 distinct sub-questions " +
      "that together must be answered to cover it well. Write them in the same language as the topic.",
    user: `Topic: ${topic}`,
  };
}

/* ---------------------------------------------------------------- queries */

export const QUERIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      description: "2 to 5 web search queries aimed at what is still missing.",
      items: { type: "string" },
    },
  },
} as const;

const queriesSchema = z.object({ queries: z.array(z.string()) });

export function parseQueries(value: unknown, max = 5): string[] {
  const parsed = queriesSchema.safeParse(value);
  if (!parsed.success) return [];
  return distinctTrimmed(parsed.data.queries, max);
}

export function buildQueriesPrompt(input: {
  topic: string;
  plan: string[];
  gaps: string[];
}) {
  return {
    system:
      "You plan web searches for a research task. Write 2 to 5 short, distinct queries that " +
      "would find authoritative, readable pages about what is still missing. Use the language of " +
      "the topic, adding an English query when English sources are likely to help.",
    user:
      `Topic: ${input.topic}\n\n` +
      `Sub-questions:\n${bullets(input.plan)}\n\n` +
      (input.gaps.length
        ? `Still missing:\n${bullets(input.gaps)}`
        : "Nothing has been gathered yet."),
  };
}

/* ----------------------------------------------------------------- select */

export const SELECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["urls"],
  properties: {
    urls: {
      type: "array",
      description:
        "The urls, copied unchanged from the provided list, most worth reading in full.",
      items: { type: "string" },
    },
  },
} as const;

const selectSchema = z.object({ urls: z.array(z.string()) });

export function parseSelection(value: unknown): string[] {
  const parsed = selectSchema.safeParse(value);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of parsed.data.urls) {
    const url = raw.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function buildSelectPrompt(input: {
  topic: string;
  gaps: string[];
  hits: { url: string; title: string; snippet?: string }[];
}) {
  return {
    system:
      "You pick which search results are worth reading in full for a research task. Choose only " +
      "the urls from the list that look most relevant and trustworthy, and return them unchanged.",
    user:
      `Topic: ${input.topic}\n\n` +
      (input.gaps.length ? `Still missing:\n${bullets(input.gaps)}\n\n` : "") +
      `Results:\n${input.hits
        .map(
          (hit) =>
            `- ${hit.url}\n  ${hit.title}${hit.snippet ? `\n  ${hit.snippet}` : ""}`,
        )
        .join("\n")}`,
  };
}

/* ----------------------------------------------------------------- digest */

export const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages", "enough", "missing"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "points", "quotes"],
        properties: {
          url: {
            type: "string",
            description: "One of the page urls supplied, copied unchanged.",
          },
          points: {
            type: "array",
            description: "Key points from this page relevant to the topic.",
            items: { type: "string" },
          },
          quotes: {
            type: "array",
            description:
              "Sentences copied verbatim from this page's text that support the points.",
            items: { type: "string" },
          },
        },
      },
    },
    enough: {
      type: "boolean",
      description: "True when the evidence gathered so far answers the topic.",
    },
    missing: {
      type: "array",
      description:
        "What still needs to be found; empty when nothing is missing.",
      items: { type: "string" },
    },
  },
} as const;

const digestSchema = z.object({
  pages: z
    .array(
      z.object({
        url: z.string(),
        points: z.array(z.string()).default([]),
        quotes: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  enough: z.boolean().default(false),
  missing: z.array(z.string()).default([]),
});

export type DigestResult = {
  pages: { url: string; points: string[]; quotes: string[] }[];
  enough: boolean;
  missing: string[];
};

export function parseDigest(value: unknown): DigestResult {
  const parsed = digestSchema.safeParse(value);
  if (!parsed.success) return { pages: [], enough: false, missing: [] };
  return {
    pages: parsed.data.pages.map((page) => ({
      url: page.url.trim(),
      points: page.points.map((point) => point.trim()).filter(Boolean),
      quotes: page.quotes.map((quote) => quote.trim()).filter(Boolean),
    })),
    enough: parsed.data.enough,
    missing: distinctTrimmed(parsed.data.missing, 10),
  };
}

export function buildDigestPrompt(input: {
  topic: string;
  plan: string[];
  pages: { url: string; title: string; text: string }[];
}) {
  return {
    system:
      "You read web pages for a research task and extract evidence. For each page, list the key " +
      "points relevant to the topic and, for each point, copy one supporting sentence verbatim from " +
      "that page's text; never paraphrase the quotes. Then say whether the evidence so far is enough " +
      "to answer the topic and what is still missing. Use only the supplied page text, and write the " +
      "points and gaps in the same language as the topic.",
    user:
      `Topic: ${input.topic}\n\n` +
      `Sub-questions:\n${bullets(input.plan)}\n\n` +
      input.pages
        .map(
          (page, index) =>
            `Page ${index + 1} (${page.url}) — ${page.title}\n${page.text}`,
        )
        .join("\n\n---\n\n"),
  };
}

/* ----------------------------------------------------------------- report */

export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["report"],
  properties: {
    report: {
      type: "string",
      description:
        "The report in Markdown, every claim cited as [[entry-id|exact quote sentence]].",
    },
  },
} as const;

const reportSchema = z.object({ report: z.string() });

export function parseReport(value: unknown): string | null {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) return null;
  const report = parsed.data.report.trim();
  return report || null;
}

export function buildReportPrompt(input: {
  topic: string;
  plan: string[];
  ledger: LedgerEntry[];
  unknownIds?: string[];
}) {
  const evidence = input.ledger
    .map(
      (entry) =>
        `[${entry.id}] ${entry.title} (${entry.url})\n` +
        `  points: ${entry.points.join("; ")}\n` +
        `  quotes: ${entry.quotes.map((quote) => `"${quote}"`).join(" ")}`,
    )
    .join("\n");
  return {
    system:
      "You write a research report using only the evidence provided below. Do not add facts that are " +
      "not in the evidence. Cite every claim as [[entry-id|exact quote sentence]], where entry-id is one " +
      "of the provided ids and the quote is copied verbatim from that entry's quotes. Never invent an id. " +
      "Write the report in the same language as the topic.",
    user:
      `Topic: ${input.topic}\n\n` +
      (input.unknownIds?.length
        ? `Your previous draft cited ids that do not exist: ${input.unknownIds.join(
            ", ",
          )}. Use only the ids listed below.\n\n`
        : "") +
      `Sub-questions:\n${bullets(input.plan)}\n\n` +
      `Evidence:\n${evidence}`,
  };
}

/* --------------------------------------------------------- call descriptors */

/** The `{ name, description, schema }` each structured call passes to the model. */
export const RESEARCH_SCHEMAS = {
  plan: {
    name: "research_plan",
    description: "Sub-questions that together cover the topic.",
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
  },
  queries: {
    name: "research_queries",
    description: "Web search queries for the open gaps.",
    schema: QUERIES_SCHEMA as unknown as Record<string, unknown>,
  },
  selection: {
    name: "research_selection",
    description: "The urls worth reading in full.",
    schema: SELECT_SCHEMA as unknown as Record<string, unknown>,
  },
  digest: {
    name: "research_digest",
    description: "Per-page points and verbatim quotes, and what is missing.",
    schema: DIGEST_SCHEMA as unknown as Record<string, unknown>,
  },
  report: {
    name: "research_report",
    description: "A cited research report in Markdown.",
    schema: REPORT_SCHEMA as unknown as Record<string, unknown>,
  },
} as const;
