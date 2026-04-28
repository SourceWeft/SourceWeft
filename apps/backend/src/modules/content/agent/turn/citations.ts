import type { AgentCitation } from "../citation-registry";

export function extractCitationKeys(text: string) {
  return [...text.matchAll(/\[citation:(c\d+)\]/g)].map(
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

  const allowed = new Set(input.citations.map((citation) => citation.citation));
  const invalidKeys = [
    ...new Set(referencedKeys.filter((key) => !allowed.has(key))),
  ];
  return {
    valid: invalidKeys.length === 0,
    invalidKeys,
  };
}
