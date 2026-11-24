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
  "clients", "registry", "github", "data", "platform", "based", "built", "simple", "easy", "new",
].map((term) => term.toLowerCase()));

const MIN_TERM_LENGTH = 3;
/** Distinct meaningful words two listings must share to be called related. */
export const MCP_RELATED_MIN_SHARED_TERMS = 2;

/**
 * Federation fills the summary of an entry whose registry text has none with
 * a placeholder ("MCP server <identifier> from the MCP registry."): it says
 * nothing about the server, so it never counts as text.
 */
const PLACEHOLDER_SUMMARY = /^\s*MCP server \S+ from the MCP registry\.?\s*$/i;

/** The registry summary, or "" for federation's placeholder sentence. */
export function mcpRealSummary(summary: string | null | undefined) {
  return summary && !PLACEHOLDER_SUMMARY.test(summary) ? summary : "";
}

export function mcpMeaningfulTerms(...texts: Array<string | null | undefined>) {
  const terms = new Set<string>();
  for (const text of texts) {
    if (text && PLACEHOLDER_SUMMARY.test(text)) continue;
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
      for (const term of mcpMeaningfulTerms(
        candidate.name,
        candidate.summary,
      )) {
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

/** Servers a detail page names under "related": the keyword matches, then the fill. */
export const MCP_RELATED_TOTAL = 6;

type FillSubject = RelatedSubject &
  Partial<Pick<MarketItemSummary, "providerName" | "runtime">>;

/**
 * Same-category servers that fill the "related" block up to `total` when too
 * few share meaningful words (#745). Deterministic, no model: a candidate must
 * share a category with `current`; ranked by the same publisher, then the same
 * runtime, then the most shared categories, then identifier, so the list never
 * changes between renders. Skips the page itself, the keyword `matched` ones
 * and repeated identifiers. Empty when the page has no category.
 */
export function fillRelatedMcpItems<T extends FillSubject>(input: {
  current: FillSubject;
  candidates: readonly T[];
  matched?: readonly { identifier: string }[];
  total?: number;
}): T[] {
  const categories = new Set(input.current.categories);
  const taken = new Set([
    input.current.identifier,
    ...(input.matched ?? []).map((item) => item.identifier),
  ]);
  const room =
    (input.total ?? MCP_RELATED_TOTAL) - (input.matched?.length ?? 0);
  if (room <= 0 || categories.size === 0) return [];
  const provider = input.current.providerName?.trim().toLowerCase() || null;
  return input.candidates
    .filter((candidate) => {
      if (taken.has(candidate.identifier)) return false;
      taken.add(candidate.identifier);
      return candidate.categories.some((category) => categories.has(category));
    })
    .map((candidate) => ({
      candidate,
      sameProvider:
        provider !== null &&
        candidate.providerName?.trim().toLowerCase() === provider
          ? 1
          : 0,
      sameRuntime:
        input.current.runtime !== undefined &&
        candidate.runtime === input.current.runtime
          ? 1
          : 0,
      shared: candidate.categories.filter((category) =>
        categories.has(category),
      ).length,
    }))
    .sort(
      (left, right) =>
        right.sameProvider - left.sameProvider ||
        right.sameRuntime - left.sameRuntime ||
        right.shared - left.shared ||
        left.candidate.identifier.localeCompare(right.candidate.identifier),
    )
    .slice(0, room)
    .map((entry) => entry.candidate);
}
