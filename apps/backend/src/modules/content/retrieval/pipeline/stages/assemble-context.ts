import type { RetrievalCandidate } from "../../planner";
import {
  listDocumentChunkStats,
  listDocumentChunksForDocument,
  listDocumentChunksInRange,
  type RetrievalDocumentChunk,
  type RetrievalDocumentChunkStats,
} from "../../repository";
import {
  DEFAULT_CONTEXT_MAX_SIDE_CHUNKS,
  DEFAULT_CONTEXT_MAX_SMALL_DOCUMENTS,
  DEFAULT_CONTEXT_MAX_TOTAL_CHARS,
  DEFAULT_CONTEXT_MAX_TOTAL_CHUNKS,
  DEFAULT_CONTEXT_MAX_WINDOW_CHARS,
  DEFAULT_CONTEXT_MIN_CHARS,
  DEFAULT_CONTEXT_SMALL_DOCUMENT_CHARS,
  DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS,
} from "../constants";
import { requirePreparedRetrievalState } from "../state";
import type { ContextAssemblyMetadata, RetrievalPipelineStage } from "../types";

type ContextRole = NonNullable<RetrievalCandidate["contextRole"]>;

const CONTEXT_SCORE_DECAY = 0.85;
const CONTEXT_ROLE_PRIORITY: Record<ContextRole, number> = {
  neighbor: 1,
  small_document: 2,
  primary: 3,
};

function documentKey(input: { sourceId: string; documentId: string }) {
  return `${input.sourceId}:${input.documentId}`;
}

function countChars(chunks: Array<{ content: string }>) {
  return chunks.reduce((total, chunk) => total + chunk.content.length, 0);
}

function asPrimaryCandidate(candidate: RetrievalCandidate): RetrievalCandidate {
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

function ensurePrimaryChunkIncluded(
  chunks: RetrievalDocumentChunk[],
  primary: RetrievalCandidate,
) {
  if (chunks.some((chunk) => chunk.chunkId === primary.chunkId)) {
    return chunks;
  }

  return [...chunks, candidateAsDocumentChunk(primary)].sort(
    (left, right) => left.chunkNo - right.chunkNo,
  );
}

function toContextCandidate(input: {
  chunk: RetrievalDocumentChunk;
  primary: RetrievalCandidate;
  role: Exclude<ContextRole, "primary">;
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
  T extends { chunkNo: number; content: string },
>(chunks: T[], primaryChunkNo: number, maxChars: number): T[] {
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

function buildEmptyMetadata(
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

function createAssemblyAccumulator() {
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

  const add = (candidate: RetrievalCandidate) => {
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
        totalChars + candidate.content.length > DEFAULT_CONTEXT_MAX_TOTAL_CHARS)
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
  };

  return {
    add,
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

export const assembleContextStage: RetrievalPipelineStage = {
  name: "assemble-context",
  async run(state) {
    const prepared = requirePreparedRetrievalState(state);
    const { input } = prepared;
    const primaryCandidates = state.candidates.final.map(asPrimaryCandidate);

    if (
      prepared.retrievalSourceIds.length === 0 ||
      primaryCandidates.length === 0
    ) {
      return {
        ...state,
        contextAssembly: buildEmptyMetadata(primaryCandidates.length),
      };
    }

    const documentRefs = [
      ...new Map(
        primaryCandidates.map((candidate) => [
          documentKey(candidate),
          {
            documentId: candidate.documentId,
            sourceId: candidate.sourceId,
          },
        ]),
      ).values(),
    ];
    const stats = await listDocumentChunkStats({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      documents: documentRefs,
    });
    const statsByDocument = new Map(
      stats.map((record) => [documentKey(record), record]),
    );
    const smallDocumentKeys = new Set<string>();
    for (const candidate of primaryCandidates) {
      const key = documentKey(candidate);
      if (smallDocumentKeys.has(key)) {
        continue;
      }
      if (
        smallDocumentKeys.size < DEFAULT_CONTEXT_MAX_SMALL_DOCUMENTS &&
        isSmallDocumentStats(statsByDocument.get(key))
      ) {
        smallDocumentKeys.add(key);
      }
    }

    const documentChunkCache = new Map<string, RetrievalDocumentChunk[]>();
    const rangeChunkCache = new Map<string, RetrievalDocumentChunk[]>();
    const accumulator = createAssemblyAccumulator();

    for (const primary of primaryCandidates) {
      const key = documentKey(primary);
      const statsRecord = statsByDocument.get(key);

      if (smallDocumentKeys.has(key)) {
        let chunks = documentChunkCache.get(key);
        if (!chunks) {
          chunks = await listDocumentChunksForDocument({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            documentId: primary.documentId,
            sourceId: primary.sourceId,
            limit: Math.max(
              statsRecord?.chunkCount ?? DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS,
              DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS,
            ),
          });
          chunks = ensurePrimaryChunkIncluded(chunks, primary);
          documentChunkCache.set(key, chunks);
        }

        for (const chunk of chunks) {
          accumulator.add(
            toContextCandidate({
              chunk,
              primary,
              role: "small_document",
            }),
          );
        }
        continue;
      }

      let sideChunks = 1;
      let windowChunks: RetrievalDocumentChunk[] = [];
      while (sideChunks <= DEFAULT_CONTEXT_MAX_SIDE_CHUNKS) {
        const startChunkNo = Math.max(0, primary.chunkNo - sideChunks);
        const endChunkNo = primary.chunkNo + sideChunks;
        const rangeKey = `${key}:${startChunkNo}:${endChunkNo}`;
        let chunks = rangeChunkCache.get(rangeKey);
        if (!chunks) {
          chunks = await listDocumentChunksInRange({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            documentId: primary.documentId,
            sourceId: primary.sourceId,
            startChunkNo,
            endChunkNo,
          });
          chunks = ensurePrimaryChunkIncluded(chunks, primary);
          rangeChunkCache.set(rangeKey, chunks);
        }
        windowChunks = chunks;
        if (
          countChars(windowChunks) >= DEFAULT_CONTEXT_MIN_CHARS ||
          sideChunks === DEFAULT_CONTEXT_MAX_SIDE_CHUNKS
        ) {
          break;
        }
        sideChunks += 1;
      }

      for (const chunk of trimContextWindowToChars(
        windowChunks,
        primary.chunkNo,
        DEFAULT_CONTEXT_MAX_WINDOW_CHARS,
      )) {
        accumulator.add(
          toContextCandidate({
            chunk,
            primary,
            role: "neighbor",
          }),
        );
      }
    }

    const assembledCandidates =
      accumulator.candidates.length > 0
        ? accumulator.candidates
        : primaryCandidates;

    return {
      ...state,
      candidates: {
        ...state.candidates,
        final: assembledCandidates,
      },
      contextAssembly: {
        primaryCandidateCount: primaryCandidates.length,
        assembledChunkCount: assembledCandidates.length,
        expandedNeighborCount: assembledCandidates.filter(
          (candidate) => candidate.contextRole === "neighbor",
        ).length,
        smallDocumentCount: smallDocumentKeys.size,
        finalContextChars: countChars(assembledCandidates),
        documentCount: documentRefs.length,
        contextTruncated: accumulator.contextTruncated,
      },
    };
  },
};
