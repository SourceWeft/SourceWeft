import { vectorSearchProvider } from "../vector";
import type {
  EmbeddingProfileRecord,
  EmbeddingVectorStrategy,
} from "../types";

export type RetrievalCandidate = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  score: number;
  stage: "bm25" | "vector";
};

export type RetrievalPlannerResult = {
  strategy: EmbeddingVectorStrategy;
  annIndexUsed: string | null;
  requestedDimensions: number | null;
};

const STATIC_ANN_INDEXES: Record<string, string> = {
  "global:embedding:bge-m3-1024:1024":
    "chunk_embeddings_global_embedding_bge_m3_1024_hnsw_idx",
};

function getStaticAnnIndex(profileId: string, dimensions: number | null) {
  if (dimensions === null) {
    return null;
  }

  return STATIC_ANN_INDEXES[`${profileId}:${dimensions}`] ?? null;
}

export function reciprocalRankFusion(input: {
  vectorCandidates: RetrievalCandidate[];
  bm25Candidates: RetrievalCandidate[];
  limit: number;
  rrfK: number;
}) {
  const scores = new Map<
    string,
    RetrievalCandidate & { rrfScore: number; stages: Set<"bm25" | "vector"> }
  >();

  const accumulate = (candidates: RetrievalCandidate[]) => {
    candidates.forEach((candidate, index) => {
      const rankScore = 1 / (input.rrfK + index + 1);
      const existing = scores.get(candidate.chunkId);
      if (existing) {
        existing.rrfScore += rankScore;
        existing.stages.add(candidate.stage);
        existing.score = Math.max(existing.score, candidate.score);
        return;
      }

      scores.set(candidate.chunkId, {
        ...candidate,
        rrfScore: rankScore,
        stages: new Set([candidate.stage]),
      });
    });
  };

  accumulate(input.vectorCandidates);
  accumulate(input.bm25Candidates);

  return [...scores.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore)
    .slice(0, input.limit)
    .map((candidate) => ({
      ...candidate,
      stages: [...candidate.stages],
    }));
}

export function planRetrievalStrategy(
  profile: EmbeddingProfileRecord,
): RetrievalPlannerResult {
  const dimensions = profile.requestedDimensions ?? null;
  vectorSearchProvider.validateDimensions(dimensions);

  if (profile.vectorStrategy === "disabled") {
    return {
      strategy: "bm25_only",
      annIndexUsed: null,
      requestedDimensions: dimensions,
    };
  }

  if (profile.vectorStrategy === "exact") {
    return {
      strategy: "exact_vector",
      annIndexUsed: null,
      requestedDimensions: dimensions,
    };
  }

  const annIndex = getStaticAnnIndex(profile.id, dimensions);
  if (annIndex && vectorSearchProvider.supportsAnn(dimensions)) {
    return {
      strategy: "ann_hnsw",
      annIndexUsed: annIndex,
      requestedDimensions: dimensions,
    };
  }

  return {
    strategy: "exact_vector",
    annIndexUsed: null,
    requestedDimensions: dimensions,
  };
}

export function buildCitationMetadata(candidates: RetrievalCandidate[]) {
  return candidates.map((candidate, index) => ({
    citation: index + 1,
    sourceId: candidate.sourceId,
    documentId: candidate.documentId,
    chunkId: candidate.chunkId,
    score: Number(candidate.score.toFixed(6)),
    excerpt: candidate.content.slice(0, 240),
  }));
}
