import type { MarketItemSummary } from "@sourceweft/market-contracts";

/**
 * "More servers like X" (#367): a server is related when it shares meaningful
 * words with this one, not merely a category. Words every MCP listing uses
 * ("mcp", "server", "api", "tools", "cloud") and plain function words say
 * nothing about what a server does, so they never count.
 */
const GENERIC_TERMS = new Set([
  "mcp", "server", "servers", "api", "apis", "tool", "tools", "cloud", "the",
  "and", "for", "with", "your", "you", "that", "this", "from", "into", "are",
  "can", "use", "uses", "using", "via", "any", "all", "its", "our", "open",
  "source", "model", "context", "protocol", "app", "apps", "service",
  "services", "integration", "integrations", "official", "hosted", "remote",
  "local", "access", "manage", "provides", "provide", "allows", "allow",
  "enables", "enable", "llm", "llms", "agent", "agents", "client",
  "clients", "data", "platform", "based", "built", "simple", "easy", "new",
].map((term) => term.toLowerCase()));

const MIN_TERM_LENGTH = 3;
/** Distinct meaningful words two listings must share to be called related. */
export const MCP_RELATED_MIN_SHARED_TERMS = 2;

export function mcpMeaningfulTerms(...texts: Array<string | null | undefined>) {
  const terms = new Set<string>();
  for (const text of texts) {
    for (const term of (text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ??
      []) {
      if (term.length >= MIN_TERM_LENGTH && !GENERIC_TERMS.has(term)) {
        terms.add(term);
      }
    }
  }
  return terms;
}

type RelatedSubject = Pick<
  MarketItemSummary,
  "identifier" | "name" | "summary" | "categories"
>;

/** At most `limit` of `candidates` that share enough meaningful words with `current`. */
export function relatedMcpItems<T extends RelatedSubject>(input: {
  current: RelatedSubject;
  candidates: readonly T[];
  limit?: number;
}): T[] {
  const own = mcpMeaningfulTerms(input.current.name, input.current.summary);
  if (own.size === 0) return [];
  const categories = new Set(input.current.categories);
  return input.candidates
    .filter((candidate) => candidate.identifier !== input.current.identifier)
    .map((candidate) => {
      let shared = 0;
      for (const term of mcpMeaningfulTerms(candidate.name, candidate.summary)) {
        if (own.has(term)) shared += 1;
      }
      return {
        candidate,
        shared,
        sameCategory: candidate.categories.filter((category) =>
          categories.has(category),
        ).length,
      };
    })
    .filter((entry) => entry.shared >= MCP_RELATED_MIN_SHARED_TERMS)
    .sort(
      (left, right) =>
        right.shared - left.shared || right.sameCategory - left.sameCategory,
    )
    .slice(0, input.limit ?? 3)
    .map((entry) => entry.candidate);
}
