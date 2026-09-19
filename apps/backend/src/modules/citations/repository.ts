import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { chunks, citations, db, sources, threads } from "@sourceweft/db";

export async function createCitationRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageId: string;
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
    })),
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
      rank: citations.rank,
      score: citations.score,
      externalUri: citations.externalUri,
      metadataJson: citations.metadataJson,
      sourceTitle: sources.title,
      chunkContent: chunks.content,
    })
    .from(citations)
    .innerJoin(threads, and(eq(threads.id, citations.threadId), eq(threads.teamId, citations.teamId), eq(threads.workspaceId, citations.workspaceId)))
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
