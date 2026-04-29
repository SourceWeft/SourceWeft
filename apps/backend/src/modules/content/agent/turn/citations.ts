import type { AgentCitation } from "../citation-registry";

const CITATION_MARKER_PATTERN = /\[citation:([^\]\s]+)\]/g;

export function extractCitationKeys(text: string) {
  return [...text.matchAll(CITATION_MARKER_PATTERN)].map(
    (match) => match[1] ?? "",
  );
}

export function validateAssistantCitations(input: {
  assistantText: string;
  citations: AgentCitation[];
}) {
  const referencedKeys = extractCitationKeys(input.assistantText);
  if (referencedKeys.length === 0) {
    return { valid: true, invalidKeys: [] as string[] };
  }

  const allowed = new Set(
    input.citations.flatMap((citation) => [citation.citation, citation.chunkId]),
  );
  const invalidKeys = [
    ...new Set(referencedKeys.filter((key) => !allowed.has(key))),
  ];
  return {
    valid: invalidKeys.length === 0,
    invalidKeys,
  };
}

export function normalizeAssistantCitations(input: {
  assistantText: string;
  citations: AgentCitation[];
}) {
  const allowed = new Map(
    input.citations.map((citation) => [citation.citation, citation]),
  );
  const citationByChunkId = new Map(
    input.citations.map((citation) => [citation.chunkId, citation]),
  );
  const usedKeys = new Set<string>();
  const invalidKeys = new Set<string>();

  const text = input.assistantText
    .replace(/\s*\[citation:([^\]\s]+)\]/g, (match, key: string) => {
      const citation = allowed.get(key) ?? citationByChunkId.get(key);
      if (!citation) {
        invalidKeys.add(key);
        return "";
      }

      usedKeys.add(citation.citation);
      return match.replace(`[citation:${key}]`, `[citation:${citation.citation}]`);
    })
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  const citations = [...usedKeys]
    .map((key) => allowed.get(key))
    .filter((citation): citation is AgentCitation => Boolean(citation));

  return {
    text,
    citations,
    invalidKeys: [...invalidKeys],
    removedInvalidCitations: invalidKeys.size > 0,
  };
}
