import {
  asPrimaryCandidate,
  buildEmptyContextAssemblyMetadata,
  countChars,
  createAssemblyAccumulator,
  DEFAULT_CONTEXT_MAX_SIDE_CHUNKS,
  DEFAULT_CONTEXT_MAX_SMALL_DOCUMENTS,
  DEFAULT_CONTEXT_MAX_WINDOW_CHARS,
  DEFAULT_CONTEXT_MIN_CHARS,
  DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS,
  documentKey,
  ensurePrimaryChunkIncluded,
  isSmallDocumentStats,
  toContextCandidate,
  trimContextWindowToChars,
  type RetrievalDocumentChunk,
} from "../index";
import type { RetrievalDataAccess } from "../data-access";
import { requirePreparedRetrievalState } from "./state";
import type { RetrievalPipelineStage, RetrievalPipelineState } from "./types";

export function createAssembleContextStage(deps: {
  dataAccess: RetrievalDataAccess;
}): RetrievalPipelineStage {
  return {
    name: "assemble-context",
    async run(state: RetrievalPipelineState): Promise<RetrievalPipelineState> {
      const prepared = requirePreparedRetrievalState(state);
      const { input } = prepared;
      const primaryCandidates = state.candidates.final.map(asPrimaryCandidate);

      if (
        prepared.retrievalSourceIds.length === 0 ||
        primaryCandidates.length === 0
      ) {
        return {
          ...state,
          contextAssembly: buildEmptyContextAssemblyMetadata(
            primaryCandidates.length,
          ),
        };
      }

      const documentRefs: { documentId: string; sourceId: string }[] = [
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
      const stats = await deps.dataAccess.listDocumentChunkStats({
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
          const chunks =
            documentChunkCache.get(key) ??
            ensurePrimaryChunkIncluded(
              await deps.dataAccess.listDocumentChunksForDocument({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                documentId: primary.documentId,
                sourceId: primary.sourceId,
                limit: Math.max(
                  statsRecord?.chunkCount ??
                    DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS,
                  DEFAULT_CONTEXT_SMALL_DOCUMENT_CHUNKS,
                ),
              }),
              primary,
            );
          if (!documentChunkCache.has(key)) {
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
        let windowChunks: readonly RetrievalDocumentChunk[] = [];
        while (sideChunks <= DEFAULT_CONTEXT_MAX_SIDE_CHUNKS) {
          const startChunkNo = Math.max(0, primary.chunkNo - sideChunks);
          const endChunkNo = primary.chunkNo + sideChunks;
          const rangeKey = `${key}:${startChunkNo}:${endChunkNo}`;
          const chunks =
            rangeChunkCache.get(rangeKey) ??
            ensurePrimaryChunkIncluded(
              await deps.dataAccess.listDocumentChunksInRange({
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                documentId: primary.documentId,
                sourceId: primary.sourceId,
                startChunkNo,
                endChunkNo,
              }),
              primary,
            );
          if (!rangeChunkCache.has(rangeKey)) {
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
}
