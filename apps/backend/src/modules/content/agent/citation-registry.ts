import type { RetrievalCandidate } from "../retrieval/planner";

export type AgentCitation = {
  citation: string;
  sourceId: string;
  sourceTitle: string;
  documentId: string;
  chunkId: string;
  chunkNo: number;
  score: number;
  excerpt: string;
  quoteText: string;
  origin: "retrieve" | "read_file";
  path?: string;
};

export type CitationRecordInput = {
  citationKey: string;
  sourceId: string;
  documentId: string;
  chunkId: string;
  quoteText: string;
  rank: number;
  score: number;
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

export class AgentCitationRegistry {
  private byChunkId = new Map<string, AgentCitation>();
  private order: string[] = [];

  addChunk(input: {
    origin: "retrieve" | "read_file";
    sourceId: string;
    sourceTitle?: string | null;
    documentId: string;
    chunkId: string;
    chunkNo: number;
    content: string;
    score?: number | null;
    path?: string;
  }) {
    const existing = this.byChunkId.get(input.chunkId);
    if (existing) {
      return existing;
    }

    const citation = `c${this.order.length + 1}`;
    const excerpt = cleanCitationExcerpt(input.content).slice(0, 320);
    const evidence: AgentCitation = {
      citation,
      sourceId: input.sourceId,
      sourceTitle: input.sourceTitle || "Untitled source",
      documentId: input.documentId,
      chunkId: input.chunkId,
      chunkNo: input.chunkNo,
      score: Number((input.score ?? 1).toFixed(6)),
      excerpt,
      quoteText: excerpt.slice(0, 400),
      origin: input.origin,
      path: input.path,
    };

    this.byChunkId.set(input.chunkId, evidence);
    this.order.push(input.chunkId);
    return evidence;
  }

  addRetrievalCandidate(candidate: RetrievalCandidate) {
    return this.addChunk({
      origin: "retrieve",
      sourceId: candidate.sourceId,
      sourceTitle: candidate.sourceTitle,
      documentId: candidate.documentId,
      chunkId: candidate.chunkId,
      chunkNo: candidate.chunkNo,
      content: candidate.content,
      score: candidate.score,
    });
  }

  list() {
    return this.order
      .map((chunkId) => this.byChunkId.get(chunkId))
      .filter((citation): citation is AgentCitation => Boolean(citation));
  }

  toCitationRecords(): CitationRecordInput[] {
    return this.list().map((citation, index) => ({
      citationKey: citation.citation,
      sourceId: citation.sourceId,
      documentId: citation.documentId,
      chunkId: citation.chunkId,
      quoteText: citation.quoteText,
      rank: index + 1,
      score: citation.score,
    }));
  }
}
