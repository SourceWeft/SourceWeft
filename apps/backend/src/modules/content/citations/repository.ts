import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../../shared/database";
import { chunks, citations, sources } from "../../../shared/db/schema";

export async function createCitationRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
  citations: Array<{
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
  }>;
}) {
  if (input.citations.length === 0) {
    return;
  }

  await db.insert(citations).values(
    input.citations.map((citation) => ({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      messageId: input.messageId,
      sourceId: citation.sourceId,
      documentId: citation.documentId,
      chunkId: citation.chunkId,
      citationKey: citation.citationKey,
      quoteText: citation.quoteText,
      rank: citation.rank,
      score: citation.score,
      externalUri: citation.externalUri ?? null,
      metadataJson: {
        sourceTitle: citation.sourceTitle,
        chunkNo: citation.chunkNo,
        excerpt: citation.excerpt,
        origin: citation.externalUri ? "external" : "source",
      },
      createdAt: new Date(),
    })),
  );
}

export async function findCitationByMessageRank(input: {
  teamId: string;
  workspaceId: string;
  messageId: string;
  rank: number;
}) {
  const rows = await db
    .select({
      id: citations.id,
      messageId: citations.messageId,
      sourceId: citations.sourceId,
      documentId: citations.documentId,
      chunkId: citations.chunkId,
      citationKey: citations.citationKey,
      quoteText: citations.quoteText,
      rank: citations.rank,
      score: citations.score,
      externalUri: citations.externalUri,
      metadataJson: citations.metadataJson,
      sourceTitle: sources.title,
      chunkContent: chunks.content,
    })
    .from(citations)
    .leftJoin(sources, eq(sources.id, citations.sourceId))
    .leftJoin(chunks, eq(chunks.id, citations.chunkId))
    .where(
      and(
        eq(citations.teamId, input.teamId),
        eq(citations.workspaceId, input.workspaceId),
        eq(citations.messageId, input.messageId),
        eq(citations.rank, input.rank),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
