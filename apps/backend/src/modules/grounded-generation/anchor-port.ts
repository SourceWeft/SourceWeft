import { anchorCitations, type AnchorableCitation } from "../citations/anchoring";
import type {
  GroundedAnchorPort,
  GroundedAnchorResult,
} from "@sourceweft/contracts/grounded-generation";

const MARKER_LIKE = /\[[^\]]*citation:[^\]]*\]/g;

/** Splits generated text into sentences, each anchored on its own. */
function sentences(text: string): string[] {
  return text
    .replace(MARKER_LIKE, " ")
    .split(/(?<=[。！？!?])|(?<=\.)\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * `GroundedAnchorPort` over the chat citation anchoring (`anchorCitations`): the
 * same word matcher and, when `embedTexts` is given, the same by-meaning pass
 * for claims and sources in different scripts. Every request becomes one
 * citation whose claims are the request's sentences; the best strong anchor
 * among them is the evidence. Weak support is no evidence.
 */
export function createGroundedAnchorPort(
  input: {
    embedTexts?: (texts: string[]) => Promise<number[][]>;
    onSemanticError?: (error: unknown) => void;
  } = {},
): GroundedAnchorPort {
  return {
    async anchor(requests) {
      if (requests.length === 0) return [];
      const lines: string[] = [];
      const citations: AnchorableCitation[] = [];
      requests.forEach((request, index) => {
        const key = `r${index}`;
        for (const sentence of sentences(request.text)) {
          const ended = /[。！？!?.]$/.test(sentence) ? sentence : `${sentence}.`;
          lines.push(`${ended} [citation:${key}]`);
        }
        citations.push({
          citation: key,
          chunkId: request.chunkId,
          content: request.chunkContent,
        });
      });
      const anchors = await anchorCitations({
        text: lines.join("\n"),
        citations,
        loadChunkContents: async () => new Map(),
        ...(input.embedTexts ? { embedTexts: input.embedTexts } : {}),
        ...(input.onSemanticError
          ? { onSemanticError: input.onSemanticError }
          : {}),
      });
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
