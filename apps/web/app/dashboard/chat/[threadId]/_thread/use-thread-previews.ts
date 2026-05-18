"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  ArtifactPreviewRecord,
  CitationRecord,
} from "../../_components/chat-canvas";
import type { ArtifactListItem } from "../../_components/sources-hub";
import type { SourceItem } from "../../_components/source-types";
import { contentClient } from "../../../../../lib/sdk";
import type { WorkfileDetail } from "./message-normalizers";

export function useThreadPreviews({
  activeAssistantVersionId,
  displayedCitations,
  sourcesVisible,
  threadId,
  toggleSourcesVisible,
  workspaceId,
}: {
  activeAssistantVersionId: string | null;
  displayedCitations: CitationRecord[];
  sourcesVisible: boolean;
  threadId: string;
  toggleSourcesVisible: () => void;
  workspaceId: string | null;
}) {
  const [activeCitationIndex, setActiveCitationIndex] = useState<number | null>(
    null,
  );
  const [previewCitation, setPreviewCitation] = useState<CitationRecord | null>(
    null,
  );
  const [previewSource, setPreviewSource] = useState<SourceItem | null>(null);
  const [previewWorkfile, setPreviewWorkfile] = useState<WorkfileDetail | null>(
    null,
  );
  const [previewArtifact, setPreviewArtifact] =
    useState<ArtifactListItem | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    string | null
  >(null);

  const handleCitationClick = useCallback(
    (citation: CitationRecord) => {
      const citationIndex = displayedCitations.findIndex(
        (item) => item.chunkId === citation.chunkId,
      );
      setActiveCitationIndex(citationIndex >= 0 ? citationIndex + 1 : null);
      setPreviewSource(null);
      setPreviewWorkfile(null);
      setPreviewCitation(citation);
      if (!sourcesVisible) {
        toggleSourcesVisible();
      }
    },
    [displayedCitations, sourcesVisible, toggleSourcesVisible],
  );

  const handleArtifactPreview = useCallback(
    (artifact: ArtifactPreviewRecord) => {
      setPreviewSource(null);
      setPreviewWorkfile(null);
      setPreviewCitation(null);
      setPreviewArtifact(artifact);
      if (!sourcesVisible) {
        toggleSourcesVisible();
      }
    },
    [sourcesVisible, toggleSourcesVisible],
  );

  const scrollToMessage = useCallback((messageId: string) => {
    const selector = `[data-chat-message-id="${CSS.escape(messageId)}"]`;
    setHighlightedMessageId(messageId);

    const scroll = () => {
      const target = document.querySelector(selector) as HTMLElement | null;
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    };

    window.requestAnimationFrame(scroll);
    window.setTimeout(scroll, 120);
    window.setTimeout(() => {
      setHighlightedMessageId((current) =>
        current === messageId ? null : current,
      );
    }, 1600);
  }, []);

  const handleSourceHubCitationOpen = useCallback(
    (citation: CitationRecord, context?: { messageId?: string }) => {
      setPreviewSource(null);
      setPreviewWorkfile(null);
      setPreviewCitation(citation);
      if (context?.messageId) {
        scrollToMessage(context.messageId);
      }
    },
    [scrollToMessage],
  );

  const handleSourcePreview = useCallback((source: SourceItem) => {
    setPreviewCitation(null);
    setPreviewWorkfile(null);
    setPreviewSource(source);
  }, []);

  const handleWorkfilePreview = useCallback(
    async (path: string) => {
      if (!workspaceId || !threadId) {
        toast.error("No thread workspace selected.");
        return;
      }

      try {
        const result = await contentClient.getWorkingFile(
          workspaceId,
          threadId,
          path,
        );
        setPreviewCitation(null);
        setPreviewSource(null);
        setPreviewWorkfile(result.file);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to load workfile.",
        );
      }
    },
    [threadId, workspaceId],
  );

  useEffect(() => {
    setActiveCitationIndex(null);
    setPreviewCitation(null);
    setPreviewSource(null);
    setPreviewWorkfile(null);
  }, [activeAssistantVersionId]);

  return {
    activeCitationIndex,
    handleArtifactPreview,
    handleCitationClick,
    handleSourceHubCitationOpen,
    handleSourcePreview,
    handleWorkfilePreview,
    highlightedMessageId,
    previewArtifact,
    previewCitation,
    previewSource,
    previewWorkfile,
    scrollToMessage,
    setActiveCitationIndex,
    setPreviewArtifact,
    setPreviewCitation,
    setPreviewSource,
    setPreviewWorkfile,
  };
}
