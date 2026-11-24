import { createHash } from "node:crypto";
import {
  GROUNDED_QUOTE_CHARS,
  type GroundedEvidence,
} from "@sourceweft/contracts/grounded-evidence";
import type {
  GroundedAnchorPort,
  GroundedAnchorResult,
} from "@sourceweft/contracts/grounded-generation";
import { isCjkChar } from "./corpus";
import type { CorpusChunk } from "./types";

export function quoteHash(quote: string) {
  return `sha256:${createHash("sha256").update(quote, "utf8").digest("hex")}`;
}

/**
 * Evidence for a chunk from an anchor result: the quote is cut to
 * `quoteChars` characters (default `GROUNDED_QUOTE_CHARS`) and hashed.
 */
export function evidenceFrom(
  chunk: CorpusChunk,
  anchor: GroundedAnchorResult,
  quoteChars: number = GROUNDED_QUOTE_CHARS,
): GroundedEvidence {
  let { startChar, endChar, quote } = anchor;
  if ([...quote].length > quoteChars) {
    quote = [...quote].slice(0, quoteChars).join("");
    endChar = startChar + quote.length;
  }
  return {
    kind: "chunk",
    sourceId: chunk.sourceId,
    documentId: chunk.documentId,
    chunkId: chunk.chunkId,
    chunkNo: chunk.chunkNo,
    headingPath: chunk.headingPath,
    quote,
    startChar,
    endChar,
    quoteHash: quoteHash(quote),
  };
}

/**
 * Where `quote` occurs word for word in `text`: compared after NFKC (width and
 * compatibility forms) and with every whitespace run read as one space, but
 * returned as the range of the original `text` (UTF-16 offsets, end
 * exclusive), so `text.slice(startChar, endChar)` is the source's own wording.
 * Case, punctuation and spelling must match. The first occurrence wins; null
 * when the text does not hold the quote or the quote is blank.
 */
export function locateQuote(
  text: string,
  quote: string,
): { startChar: number; endChar: number } | null {
  const wanted = quote.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (wanted.length === 0) return null;
  // The folded text, and for each of its UTF-16 units the original range of
  // the character (or whitespace run) it came from.
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const start = offset;
    offset += char.length;
    if (/\s/u.test(char)) {
      if (folded.endsWith(" ")) {
        ends[ends.length - 1] = offset;
      } else {
        folded += " ";
        starts.push(start);
        ends.push(offset);
      }
      continue;
    }
    const form = char.normalize("NFKC");
    folded += form;
    for (let unit = 0; unit < form.length; unit += 1) {
      starts.push(start);
      ends.push(offset);
    }
  }
  const at = folded.indexOf(wanted);
  if (at < 0) return null;
  return { startChar: starts[at]!, endChar: ends[at + wanted.length - 1]! };
}

/** What anchoring needs of a generated item: its id, its cited handles and the text to support. */
export type AnchorableItem = {
  id: string;
  refs: readonly string[];
  text: string;
};

/**
 * Anchors every item's supporting text in each chunk it cites, in one batch.
 * Returns the evidence per item id, at most `limits.evidencePerItem` entries
 * each; an item absent from the map was not supported by any of its chunks.
 */
export async function anchorCandidates(
  items: readonly AnchorableItem[],
  anchorPort: GroundedAnchorPort,
  chunkByHandle: ReadonlyMap<string, CorpusChunk>,
  limits: { evidencePerItem: number; quoteChars?: number },
): Promise<Map<string, GroundedEvidence[]>> {
  const requests: { itemId: string; chunk: CorpusChunk; text: string }[] = [];
  for (const item of items) {
    for (const ref of item.refs) {
      const chunk = chunkByHandle.get(ref);
      if (chunk) requests.push({ itemId: item.id, chunk, text: item.text });
    }
  }
  const evidence = new Map<string, GroundedEvidence[]>();
  if (requests.length === 0) return evidence;
  const results = await anchorPort.anchor(
    requests.map((request) => ({
      text: request.text,
      chunkId: request.chunk.chunkId,
      chunkContent: request.chunk.text,
    })),
  );
  requests.forEach((request, index) => {
    const result = results[index];
    if (!result || result.quote.trim().length === 0) return;
    const list = evidence.get(request.itemId) ?? [];
    if (list.length < limits.evidencePerItem) {
      list.push(evidenceFrom(request.chunk, result, limits.quoteChars));
    }
    evidence.set(request.itemId, list);
  });
  return evidence;
}

/** Cited chunk text for a verification call, cut to the token budget. */
export function citedTextWithin(
  chunks: readonly CorpusChunk[],
  budgetTokens: number,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const remaining = budgetTokens - used;
    if (remaining <= 0) break;
    if (chunk.tokens <= remaining) {
      parts.push(chunk.text);
      used += chunk.tokens;
      continue;
    }
    let cut = "";
    let tokens = 0;
    let pendingOther = 0;
    for (const char of chunk.text) {
      // Same arithmetic as estimateTokens, kept incremental.
      const isCjk = isCjkChar(char);
      const next = isCjk ? tokens + 1 : tokens + (pendingOther % 4 === 0 ? 1 : 0);
      if (next > remaining) break;
      if (!isCjk) pendingOther += 1;
      tokens = next;
      cut += char;
    }
    if (cut) parts.push(cut);
    break;
  }
  return parts.join("\n\n");
}
