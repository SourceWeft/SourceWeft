import type { RetrievalCandidate } from "@sourceweft/builtin-retrieval";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";

type SourceCitationOrigin =
  | typeof AGENT_TOOL_NAMES.searchSources
  | typeof AGENT_TOOL_NAMES.readFile
  | typeof AGENT_TOOL_NAMES.grep;
type ExternalCitationOrigin =
  | typeof AGENT_TOOL_NAMES.webSearch
  | typeof AGENT_TOOL_NAMES.webFetch;
type AgentCitationOrigin = SourceCitationOrigin | ExternalCitationOrigin;

export type AgentCitation = {
  citation: string;
  sourceId: string | null;
  sourceTitle: string;
  documentId: string | null;
  chunkId: string;
  chunkNo?: number;
  score: number;
  excerpt: string;
  quoteText: string;
  content?: string;
  origin: AgentCitationOrigin;
  externalUri?: string;
  path?: string;
};

export type CitationRecordInput = {
  citationKey: string;
  sourceId: string | null;
  documentId: string | null;
  chunkId: string | null;
  quoteText: string;
  rank: number;
  score: number;
  externalUri?: string;
  content?: string;
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

function cleanCitationContent(content: string) {
  return content
    .replace(/\r\n?/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export class AgentCitationRegistry {
  private byChunkId = new Map<string, AgentCitation>();
  private byExternalUri = new Map<string, AgentCitation>();
  private order: string[] = [];

  private addEvidence(key: string, evidence: AgentCitation) {
    this.byChunkId.set(key, evidence);
    this.order.push(key);
    return evidence;
  }

  addChunk(input: {
    origin: SourceCitationOrigin;
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

    return this.addEvidence(input.chunkId, evidence);
  }

  addRetrievalCandidate(candidate: RetrievalCandidate) {
    return this.addChunk({
      origin: AGENT_TOOL_NAMES.searchSources,
      sourceId: candidate.sourceId,
      sourceTitle: candidate.sourceTitle,
      documentId: candidate.documentId,
      chunkId: candidate.chunkId,
      chunkNo: candidate.chunkNo,
      content: candidate.content,
      score: candidate.score,
    });
  }

  addExternal(input: {
    origin: ExternalCitationOrigin;
    externalUri: string;
    sourceTitle?: string | null;
    content: string;
    excerptContent?: string;
    fullContent?: string;
    score?: number | null;
  }) {
    const fullContent = cleanCitationContent(input.fullContent ?? "");
    const excerptSource = input.excerptContent || input.content;
    const excerpt = cleanCitationExcerpt(excerptSource).slice(0, 320);
    const existing = this.byExternalUri.get(input.externalUri);
    if (existing) {
      if (!existing.content && fullContent) {
        existing.content = fullContent;
      }
      if (!existing.excerpt && excerpt) {
        existing.excerpt = excerpt;
        existing.quoteText = excerpt.slice(0, 400);
      }
      return existing;
    }

    const citation = `c${this.order.length + 1}`;
    const key = `external:${input.externalUri}`;
    const evidence: AgentCitation = {
      citation,
      sourceId: null,
      sourceTitle: input.sourceTitle || input.externalUri,
      documentId: null,
      chunkId: key,
      score: Number((input.score ?? 1).toFixed(6)),
      excerpt,
      quoteText: excerpt.slice(0, 400),
      ...(fullContent ? { content: fullContent } : {}),
      origin: input.origin,
      externalUri: input.externalUri,
    };

    this.byExternalUri.set(input.externalUri, evidence);
    return this.addEvidence(key, evidence);
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
      chunkId: citation.externalUri ? null : citation.chunkId,
      quoteText: citation.quoteText,
      rank: index + 1,
      score: citation.score,
      externalUri: citation.externalUri,
      content: citation.content,
    }));
  }
}
