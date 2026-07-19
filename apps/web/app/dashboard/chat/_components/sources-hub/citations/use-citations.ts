import { useEffect, useMemo, useState } from "react";

import type { CitationRecord } from "../../chat-canvas";

export type CitationScope = "current" | "thread";

export type ThreadCitationRecord = {
  citation: CitationRecord;
  id: string;
  messageId: string;
  messageLabel: string;
};

export type CitationOpenContext = {
  messageId?: string;
};

export type DisplayCitationItem = {
  id: string;
  sourceTitle: string;
  messageLabel: string;
  excerpt: string;
  citationRecord: CitationRecord;
  messageId?: string;
};

function mapCitationsToUi(citations: CitationRecord[]): DisplayCitationItem[] {
  return citations.map((citation, index) => ({
    id: `citation-${citation.citation}-${citation.chunkId}`,
    citationRecord: citation,
    sourceTitle: citation.sourceTitle?.trim() || "Untitled source",
    messageLabel: `Reference ${index + 1}`,
    excerpt: citation.excerpt,
  }));
}

function mapThreadCitationsToUi(
  citations: ThreadCitationRecord[],
): DisplayCitationItem[] {
  return citations.map((item) => ({
    id: item.id,
    citationRecord: item.citation,
    messageId: item.messageId,
    sourceTitle: item.citation.sourceTitle?.trim() || "Untitled source",
    messageLabel: item.messageLabel,
    excerpt: item.citation.excerpt,
  }));
}

function filterCitations(items: DisplayCitationItem[], searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    return items;
  }
  return items.filter(
    (citation) =>
      citation.sourceTitle.toLowerCase().includes(q) ||
      citation.messageLabel.toLowerCase().includes(q) ||
      citation.excerpt.toLowerCase().includes(q) ||
      citation.citationRecord.citation.toLowerCase().includes(q),
  );
}

export function useCitations(input: {
  mode: "thread" | "new";
  citations: CitationRecord[];
  threadCitations: ThreadCitationRecord[];
  activeCitationIndex: number | null;
  searchQuery: string;
}) {
  const { mode, citations, threadCitations, activeCitationIndex, searchQuery } =
    input;

  const [citationScope, setCitationScope] = useState<CitationScope>("current");

  useEffect(() => {
    setCitationScope("current");
  }, [mode]);

  const currentCitationItems = useMemo(
    () => mapCitationsToUi(citations),
    [citations],
  );
  const threadCitationItems = useMemo(
    () => mapThreadCitationsToUi(threadCitations),
    [threadCitations],
  );
  const activeCitationItems =
    citationScope === "thread" ? threadCitationItems : currentCitationItems;
  const filteredCitationItems = useMemo(
    () => filterCitations(activeCitationItems, searchQuery),
    [activeCitationItems, searchQuery],
  );
  const activeCitationChunkId = activeCitationIndex
    ? (citations[activeCitationIndex - 1]?.chunkId ?? null)
    : null;

  return {
    citationScope,
    setCitationScope,
    currentCitationItems,
    threadCitationItems,
    activeCitationItems,
    filteredCitationItems,
    activeCitationChunkId,
  };
}
