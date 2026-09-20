import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import type { CitationRecord } from "../../chat-canvas";

type CitationsT = ReturnType<typeof useTranslations>;

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

function mapCitationsToUi(
  citations: CitationRecord[],
  t: CitationsT,
): DisplayCitationItem[] {
  return citations.map((citation, index) => ({
    id: `citation-${citation.citation}-${citation.chunkId}`,
    citationRecord: citation,
    sourceTitle:
      citation.sourceTitle?.trim() || t("citations.untitledSource"),
    messageLabel: t("citations.reference", { number: index + 1 }),
    excerpt: citation.excerpt,
  }));
}

function mapThreadCitationsToUi(
  citations: ThreadCitationRecord[],
  t: CitationsT,
): DisplayCitationItem[] {
  return citations.map((item) => ({
    id: item.id,
    citationRecord: item.citation,
    messageId: item.messageId,
    sourceTitle:
      item.citation.sourceTitle?.trim() || t("citations.untitledSource"),
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

  const t = useTranslations("dashboardSourcesHub");
  const [citationScope, setCitationScope] = useState<CitationScope>("current");

  useEffect(() => {
    setCitationScope("current");
  }, [mode]);

  const currentCitationItems = useMemo(
    () => mapCitationsToUi(citations, t),
    [citations, t],
  );
  const threadCitationItems = useMemo(
    () => mapThreadCitationsToUi(threadCitations, t),
    [threadCitations, t],
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
