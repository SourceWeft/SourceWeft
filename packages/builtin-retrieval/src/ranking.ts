import type { RetrievalCandidate, RetrievalCandidateStage } from "./types";

type RrfCandidate = Omit<RetrievalCandidate, "stages"> & {
  readonly rrfScore: number;
  readonly stages: ReadonlySet<RetrievalCandidateStage>;
};

function cleanCitationExcerpt(content: string) {
  return content
    .replace(/<\/?(?:table|thead|tbody|tr|th|td)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\\$/g, "$ ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toMutableStageSet(
  stages: ReadonlySet<RetrievalCandidateStage>,
): Set<RetrievalCandidateStage> {
  return new Set(stages);
}

export function reciprocalRankFusion(input: {
  readonly vectorCandidates: readonly RetrievalCandidate[];
  readonly bm25Candidates: readonly RetrievalCandidate[];
  readonly limit: number;
  readonly rrfK: number;
}) {
  const scores = new Map<string, RrfCandidate>();

  const accumulate = (candidates: readonly RetrievalCandidate[]) => {
    candidates.forEach((candidate, index) => {
      const rankScore = 1 / (input.rrfK + index + 1);
      const existing = scores.get(candidate.chunkId);
      if (existing) {
        const stages = toMutableStageSet(existing.stages);
        stages.add(candidate.stage);
        scores.set(candidate.chunkId, {
          ...existing,
          rrfScore: existing.rrfScore + rankScore,
          score: Math.max(existing.score, candidate.score),
          stages,
        });
        return;
      }

      const { stages: _stages, ...candidateWithoutStages } = candidate;
      scores.set(candidate.chunkId, {
        ...candidateWithoutStages,
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

export function buildCitationMetadata(
  candidates: readonly RetrievalCandidate[],
) {
  return candidates.map((candidate, index) => ({
    citation: `c${index + 1}`,
    sourceId: candidate.sourceId,
    sourceTitle: candidate.sourceTitle,
    documentId: candidate.documentId,
    chunkId: candidate.chunkId,
    chunkNo: candidate.chunkNo,
    score: Number(candidate.score.toFixed(6)),
    excerpt: cleanCitationExcerpt(candidate.content).slice(0, 320),
  }));
}
