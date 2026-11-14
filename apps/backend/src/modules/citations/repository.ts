import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chunks, citations, db, sources, threads } from "@sourceweft/db";
import { logger } from "../../shared/logger";
import { anchorCitations, type CitationAnchor } from "./anchoring";

async function loadChunkContents(input: {
  teamId: string;
  workspaceId: string;
  chunkIds: string[];
}) {
  if (input.chunkIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: chunks.id, content: chunks.content })
    .from(chunks)
    .where(
      and(
        eq(chunks.teamId, input.teamId),
        eq(chunks.workspaceId, input.workspaceId),
        inArray(chunks.id, input.chunkIds),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.content]));
}

/**
 * Anchors every citation the final answer uses to the passage of its chunk
 * that supports the sentence it follows. Anchoring only improves how a
 * citation is shown, so a failed lookup must not fail the turn: the citations
 * are stored with their existing excerpts, and the failure is logged so it
 * stays visible.
 */
export async function anchorAnswerCitations(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  answerText: string;
  citations: ReadonlyArray<{
    citationKey: string;
    chunkId?: string | null;
    referenceKey?: string;
    externalUri?: string | null;
    fileReference?: unknown;
    content?: string;
  }>;
}) {
  try {
    return await anchorCitations({
      text: input.answerText,
      citations: input.citations.map((citation) => ({
        citation: citation.citationKey,
        chunkId: citation.chunkId ?? citation.referenceKey ?? "",
        externalUri: citation.externalUri ?? undefined,
        fileReference: citation.fileReference,
        content: citation.content,
      })),
      loadChunkContents: (chunkIds) =>
        loadChunkContents({
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          chunkIds,
        }),
    });
  } catch (error) {
    logger.warn("Citation anchoring failed; storing citations without spans", {
      err: error,
      threadId: input.threadId,
    });
    return new Map<string, CitationAnchor>();
  }
}

export async function createCitationRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
  /** Supporting passages from `anchorAnswerCitations`, keyed by citation. */
  anchors?: ReadonlyMap<string, CitationAnchor>;
  citations: Array<{
    referenceKey?: string;
    fileReference?: import("@sourceweft/contracts").FileReference;
    citationKey: string;
    sourceId?: string | null;
    sourceTitle?: string;
    documentId?: string | null;
    chunkId?: string | null;
    chunkNo?: number;
    excerpt?: string;
    quoteText: string;
    rank: number;
    score: number;
    externalUri?: string | null;
    content?: string;
  }>;
}) {
  if (input.citations.length === 0) {
    return;
  }

  const anchors = input.anchors ?? new Map<string, CitationAnchor>();

  await db.insert(citations).values(
    input.citations.map((citation) => {
      const anchor = anchors.get(citation.citationKey);
      const anchored = anchor?.support === "strong";
      return {
        id: randomUUID(),
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        messageId: input.messageId,
        sourceId: citation.sourceId,
        documentId: citation.documentId,
        chunkId: citation.chunkId,
        citationKey: citation.citationKey,
        quoteText: anchored ? anchor.quoteText : citation.quoteText,
        startChar: anchored ? anchor.startChar : null,
        endChar: anchored ? anchor.endChar : null,
        rank: citation.rank,
        score: citation.score,
        externalUri: citation.externalUri ?? null,
        metadataJson: {
          ...(anchor
            ? {
                support: anchor.support,
                supportScore: Number(anchor.score.toFixed(3)),
              }
            : {}),
          referenceKey: citation.referenceKey,
          fileReference: citation.fileReference,
          sourceTitle: citation.sourceTitle,
          chunkNo: citation.chunkNo,
          excerpt: citation.excerpt,
          content: citation.content,
          origin: citation.fileReference
            ? "file"
            : citation.externalUri
              ? "external"
              : "source",
        },
        createdAt: new Date(),
      };
    }),
  );
}

export async function replaceCitationRecords(
  input: Parameters<typeof createCitationRecords>[0],
) {
  await db
    .delete(citations)
    .where(
      and(
        eq(citations.teamId, input.teamId),
        eq(citations.workspaceId, input.workspaceId),
        eq(citations.threadId, input.threadId),
        eq(citations.messageId, input.messageId),
      ),
    );

  await createCitationRecords(input);
}

export async function findCitationByMessageRank(input: {
  userId: string;
  teamId: string;
  workspaceId: string;
  messageId: string;
  rank: number;
}) {
  const rows = await db
    .select({
      id: citations.id,
      messageId: citations.messageId,
      threadId: citations.threadId,
      sourceId: citations.sourceId,
      documentId: citations.documentId,
      chunkId: citations.chunkId,
      citationKey: citations.citationKey,
      quoteText: citations.quoteText,
      startChar: citations.startChar,
      endChar: citations.endChar,
      rank: citations.rank,
      score: citations.score,
      externalUri: citations.externalUri,
      metadataJson: citations.metadataJson,
      sourceTitle: sources.title,
      chunkContent: chunks.content,
    })
    .from(citations)
    .innerJoin(
      threads,
      and(
        eq(threads.id, citations.threadId),
        eq(threads.teamId, citations.teamId),
        eq(threads.workspaceId, citations.workspaceId),
      ),
    )
    .leftJoin(sources, eq(sources.id, citations.sourceId))
    .leftJoin(chunks, eq(chunks.id, citations.chunkId))
    .where(
      and(
        eq(citations.teamId, input.teamId),
        eq(citations.workspaceId, input.workspaceId),
        eq(citations.messageId, input.messageId),
        eq(citations.rank, input.rank),
        sql`(${threads.visibility} <> 'private' or ${threads.createdBy} = ${input.userId})`,
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
