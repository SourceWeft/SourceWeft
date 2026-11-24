import { createHash } from "node:crypto";
import {
  anchorCitations,
  SEMANTIC_MAX_CLAIMS_PER_CITATION,
  segmentContent,
  type AnchorableCitation,
  type CitationAnchor,
} from "../citations/anchoring";
import {
  SEMANTIC_MAX_CHARS,
  SEMANTIC_MAX_SEGMENTS_PER_CHUNK,
  SEMANTIC_MAX_TEXTS,
} from "../citations/semantic-anchoring";
import type {
  GroundedAnchorPort,
  GroundedAnchorRequest,
  GroundedAnchorResult,
} from "@sourceweft/contracts/grounded-generation";

const MARKER_LIKE = /\[[^\]]*citation:[^\]]*\]/g;

/** Batches anchored at once: each may make one embedding call. */
export const ANCHOR_BATCH_CONCURRENCY = 4;

/** Splits generated text into sentences, each anchored on its own. */
function sentences(text: string): string[] {
  return text
    .replace(MARKER_LIKE, " ")
    .split(/(?<=[。！？!?])|(?<=\.)\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * An embedding billing key for one batch of texts: the same texts always get
 * the same key (a retry reuses its vectors), different texts never share one
 * (a shared key would hand a later batch the first batch's vectors).
 */
export function embeddingBatchKey(base: string, texts: readonly string[]) {
  const hash = createHash("sha256");
  for (const text of texts) hash.update(text).update("\u0000");
  return `${base}:${hash.digest("hex").slice(0, 16)}`;
}

/**
 * What one request may cost the by-meaning pass, at most: its claims plus its
 * chunk's segments, in texts and characters.
 */
function semanticCost(claims: readonly string[], content: string) {
  const counted = claims.slice(0, SEMANTIC_MAX_CLAIMS_PER_CITATION);
  const segments = segmentContent(content).slice(0, SEMANTIC_MAX_SEGMENTS_PER_CHUNK);
  return {
    texts: counted.length + segments.length,
    characters:
      counted.reduce((sum, claim) => sum + claim.length, 0) +
      segments.reduce((sum, segment) => sum + segment.end - segment.start, 0),
  };
}

type Prepared = { index: number; request: GroundedAnchorRequest; claims: string[] };

/**
 * Groups requests so that each group's by-meaning pass fits the per-call
 * bounds the chat anchoring keeps for one answer. A generator anchors many
 * items at once; one call for all of them would leave most over budget.
 */
export function batchForSemanticBudget(prepared: readonly Prepared[]): Prepared[][] {
  const batches: Prepared[][] = [];
  let batch: Prepared[] = [];
  let texts = 0;
  let characters = 0;
  for (const item of prepared) {
    const cost = semanticCost(item.claims, item.request.chunkContent);
    if (
      batch.length > 0 &&
      (texts + cost.texts > SEMANTIC_MAX_TEXTS ||
        characters + cost.characters > SEMANTIC_MAX_CHARS)
    ) {
      batches.push(batch);
      batch = [];
      texts = 0;
      characters = 0;
    }
    batch.push(item);
    texts += cost.texts;
    characters += cost.characters;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * `GroundedAnchorPort` over the chat citation anchoring (`anchorCitations`): the
 * same word matcher and, when `embedTexts` is given, the same by-meaning pass
 * for claims and sources in different scripts. Every request becomes one
 * citation whose claims are the request's sentences; the best strong anchor
 * among them is the evidence. Weak support is no evidence. Requests are
 * anchored in batches sized to the by-meaning pass's bounds, so every item of
 * a large generation can reach it; each batch makes at most one embedding call.
 */
export function createGroundedAnchorPort(
  input: {
    embedTexts?: (texts: string[]) => Promise<number[][]>;
    onSemanticError?: (error: unknown) => void;
  } = {},
): GroundedAnchorPort {
  async function anchorBatch(batch: readonly Prepared[]) {
    const lines: string[] = [];
    const citations: AnchorableCitation[] = [];
    for (const { index, request, claims } of batch) {
      const key = `r${index}`;
      for (const sentence of claims) {
        const ended = /[。！？!?.]$/.test(sentence) ? sentence : `${sentence}.`;
        lines.push(`${ended} [citation:${key}]`);
      }
      citations.push({
        citation: key,
        chunkId: request.chunkId,
        content: request.chunkContent,
      });
    }
    return anchorCitations({
      text: lines.join("\n"),
      citations,
      loadChunkContents: async () => new Map(),
      ...(input.embedTexts ? { embedTexts: input.embedTexts } : {}),
      ...(input.onSemanticError ? { onSemanticError: input.onSemanticError } : {}),
    });
  }

  return {
    async anchor(requests) {
      if (requests.length === 0) return [];
      const prepared = requests.map((request, index) => ({
        index,
        request,
        claims: sentences(request.text),
      }));
      const batches = batchForSemanticBudget(prepared);
      const anchors = new Map<string, CitationAnchor>();
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const batch = batches[next++]!;
          for (const [key, anchor] of await anchorBatch(batch)) anchors.set(key, anchor);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(ANCHOR_BATCH_CONCURRENCY, batches.length) }, worker),
      );
      return requests.map((_, index): GroundedAnchorResult | null => {
        const anchor = anchors.get(`r${index}`);
        if (
          !anchor ||
          anchor.support !== "strong" ||
          anchor.startChar === null ||
          anchor.endChar === null ||
          !anchor.quoteText
        ) {
          return null;
        }
        return {
          startChar: anchor.startChar,
          endChar: anchor.endChar,
          quote: anchor.quoteText,
          confidence: anchor.score,
        };
      });
    },
  };
}
