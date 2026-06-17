import {
  DEFAULT_CONTEXT_MAX_TOTAL_CHARS,
  DEFAULT_CONTEXT_MAX_TOTAL_CHUNKS,
  DEFAULT_CONTEXT_SMALL_DOCUMENT_CHARS,
  DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS,
} from "./constants";
import type {
  ContextAssemblyMetadata,
  RetrievalCandidate,
  RetrievalContextRole,
  RetrievalDocumentChunk,
  RetrievalDocumentChunkStats,
} from "./types";

type ContextCandidateRole = NonNullable<RetrievalContextRole>;

const CONTEXT_SCORE_DECAY = 0.85;
const CONTEXT_ROLE_PRIORITY: Record<ContextCandidateRole, number> = {
  neighbor: 1,
  small_document: 2,
  primary: 3,
};

export function documentKey(input: {
  readonly sourceId: string;
  readonly documentId: string;
}) {
  return `${input.sourceId}:${input.documentId}`;
}

export function countChars(chunks: readonly { readonly content: string }[]) {
  return chunks.reduce((total, chunk) => total + chunk.content.length, 0);
}

export function asPrimaryCandidate(
  candidate: RetrievalCandidate,
): RetrievalCandidate {
  return {
    ...candidate,
    contextRole: "primary",
    primaryChunkId: candidate.chunkId,
  };
}

function candidateAsDocumentChunk(
  candidate: RetrievalCandidate,
): RetrievalDocumentChunk {
  return {
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    sourceId: candidate.sourceId,
    sourceTitle: candidate.sourceTitle,
    chunkNo: candidate.chunkNo,
    content: candidate.content,
  };
}

export function ensurePrimaryChunkIncluded(
  chunks: readonly RetrievalDocumentChunk[],
  primary: RetrievalCandidate,
): RetrievalDocumentChunk[] {
  if (chunks.some((chunk) => chunk.chunkId === primary.chunkId)) {
    return [...chunks];
  }

  return [...chunks, candidateAsDocumentChunk(primary)].sort(
    (left, right) => left.chunkNo - right.chunkNo,
  );
}

export function toContextCandidate(input: {
  readonly chunk: RetrievalDocumentChunk;
  readonly primary: RetrievalCandidate;
  readonly role: Exclude<ContextCandidateRole, "primary">;
}): RetrievalCandidate {
  const isPrimary = input.chunk.chunkId === input.primary.chunkId;
  return {
    chunkId: input.chunk.chunkId,
    documentId: input.chunk.documentId,
    sourceId: input.chunk.sourceId,
    sourceTitle: input.chunk.sourceTitle,
    chunkNo: input.chunk.chunkNo,
    content: input.chunk.content,
    score: isPrimary
      ? input.primary.score
      : Number((input.primary.score * CONTEXT_SCORE_DECAY).toFixed(6)),
    stage: input.primary.stage,
    stages: input.primary.stages,
    contextRole: isPrimary ? "primary" : input.role,
    primaryChunkId: input.primary.chunkId,
  };
}

export function isSmallDocumentStats(
  stats: RetrievalDocumentChunkStats | null | undefined,
) {
  if (!stats) {
    return false;
  }

  return (
    stats.chunkCount <= DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS ||
    stats.totalChars <= DEFAULT_CONTEXT_SMALL_DOCUMENT_CHARS
  );
}

export function trimContextWindowToChars<
  T extends { readonly chunkNo: number; readonly content: string },
>(chunks: readonly T[], primaryChunkNo: number, maxChars: number): T[] {
  const ordered = [...chunks].sort(
    (left, right) => left.chunkNo - right.chunkNo,
  );
  if (ordered.length === 0 || maxChars <= 0) {
    return ordered;
  }

  const primary = ordered.find((chunk) => chunk.chunkNo === primaryChunkNo);
  if (!primary) {
    const selected: T[] = [];
    let selectedChars = 0;
    for (const chunk of ordered) {
      const nextChars = selectedChars + chunk.content.length;
      if (selected.length > 0 && nextChars > maxChars) {
        break;
      }
      selected.push(chunk);
      selectedChars = nextChars;
    }
    return selected;
  }

  const selectedByChunkNo = new Map<number, T>([[primary.chunkNo, primary]]);
  let selectedChars = primary.content.length;
  const siblings = ordered
    .filter((chunk) => chunk.chunkNo !== primaryChunkNo)
    .sort((left, right) => {
      const leftDistance = Math.abs(left.chunkNo - primaryChunkNo);
      const rightDistance = Math.abs(right.chunkNo - primaryChunkNo);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return left.chunkNo - right.chunkNo;
    });

  for (const chunk of siblings) {
    const nextChars = selectedChars + chunk.content.length;
    if (nextChars > maxChars) {
      continue;
    }
    selectedByChunkNo.set(chunk.chunkNo, chunk);
    selectedChars = nextChars;
  }

  return ordered.filter((chunk) => selectedByChunkNo.has(chunk.chunkNo));
}

export function buildEmptyContextAssemblyMetadata(
  primaryCandidateCount: number,
): ContextAssemblyMetadata {
  return {
    primaryCandidateCount,
    assembledChunkCount: primaryCandidateCount,
    expandedNeighborCount: 0,
    smallDocumentCount: 0,
    finalContextChars: 0,
    documentCount: 0,
    contextTruncated: false,
  };
}

export function createAssemblyAccumulator() {
  const candidates: RetrievalCandidate[] = [];
  const indexByChunkId = new Map<string, number>();
  let totalChars = 0;
  let contextTruncated = false;

  const rebuildIndex = () => {
    indexByChunkId.clear();
    candidates.forEach((candidate, index) => {
      indexByChunkId.set(candidate.chunkId, index);
    });
  };

  const removeLastNonPrimary = () => {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (!candidate || (candidate.contextRole ?? "primary") === "primary") {
        continue;
      }
      const [removed] = candidates.splice(index, 1);
      if (!removed) {
        return false;
      }
      totalChars -= removed.content.length;
      contextTruncated = true;
      rebuildIndex();
      return true;
    }

    return false;
  };

  return {
    add(candidate: RetrievalCandidate) {
      const existingIndex = indexByChunkId.get(candidate.chunkId);
      if (existingIndex !== undefined) {
        const existing = candidates[existingIndex];
        if (!existing) {
          return false;
        }
        const existingRole = existing.contextRole ?? "primary";
        const incomingRole = candidate.contextRole ?? "primary";
        if (
          CONTEXT_ROLE_PRIORITY[incomingRole] >
          CONTEXT_ROLE_PRIORITY[existingRole]
        ) {
          candidates[existingIndex] = candidate;
        }
        return true;
      }

      const role = candidate.contextRole ?? "primary";
      const isPrimary = role === "primary";
      while (
        isPrimary &&
        (candidates.length >= DEFAULT_CONTEXT_MAX_TOTAL_CHUNKS ||
          totalChars + candidate.content.length >
            DEFAULT_CONTEXT_MAX_TOTAL_CHARS)
      ) {
        if (!removeLastNonPrimary()) {
          break;
        }
      }

      if (
        candidates.length >= DEFAULT_CONTEXT_MAX_TOTAL_CHUNKS ||
        (totalChars + candidate.content.length >
          DEFAULT_CONTEXT_MAX_TOTAL_CHARS &&
          !isPrimary)
      ) {
        contextTruncated = true;
        return false;
      }

      candidates.push(candidate);
      indexByChunkId.set(candidate.chunkId, candidates.length - 1);
      totalChars += candidate.content.length;
      return true;
    },
    get candidates() {
      return candidates;
    },
    get totalChars() {
      return totalChars;
    },
    get contextTruncated() {
      return contextTruncated;
    },
  };
}
