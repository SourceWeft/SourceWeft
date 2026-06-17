import type { RetrievalCandidate } from "./types";

// ── Gateway interface ────────────────────────────────────────────────────────

export interface RerankGateway {
  rank(input: {
    query: string;
    documents: string[];
    topN: number;
  }): Promise<{ index: number; relevanceScore: number }[]>;
}

// ── Core rerank logic ────────────────────────────────────────────────────────

export async function rerankCandidates(input: {
  queryText: string;
  candidates: RetrievalCandidate[];
  topN: number;
  gateway: RerankGateway;
}): Promise<RetrievalCandidate[]> {
  if (input.candidates.length === 0) {
    return [];
  }

  const results = await input.gateway.rank({
    query: input.queryText,
    documents: input.candidates.map((c) => c.content),
    topN: Math.min(input.candidates.length, input.topN),
  });

  return results
    .map((r) => {
      const candidate = input.candidates[r.index];
      if (!candidate) {
        return null;
      }
      return {
        ...candidate,
        score: r.relevanceScore,
      };
    })
    .filter((c): c is RetrievalCandidate => c !== null);
}
