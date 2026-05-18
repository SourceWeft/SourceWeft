"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CitationRecord } from "../../_components/chat-canvas";
import type { ThreadCitationRecord } from "../../_components/sources-hub";
import type { ChatMessageItem } from "../streaming-assistant-state";
import {
  buildVersionedMessageGroups,
  EMPTY_CITATIONS,
  resolveActiveAssistantVersion,
  resolveUsedCitationsForText,
  type PendingLatestVersionSelection,
} from "./message-groups";

type UseThreadVersioningInput = {
  isStreaming: boolean;
  mergeStreamingAssistantIntoMessages: (
    messages: ChatMessageItem[],
  ) => ChatMessageItem[];
  messages: ChatMessageItem[];
};

export function useThreadVersioning({
  isStreaming,
  mergeStreamingAssistantIntoMessages,
  messages,
}: UseThreadVersioningInput) {
  const [activeVersionByGroup, setActiveVersionByGroup] = useState<
    Record<string, number>
  >({});
  const [displayedCitations, setDisplayedCitations] = useState<
    CitationRecord[]
  >([]);
  const latestSignatureByGroupRef = useRef<Record<string, string>>({});
  const pendingLatestVersionSelectionRef =
    useRef<PendingLatestVersionSelection | null>(null);

  const messageGroups = useMemo(
    () => buildVersionedMessageGroups(mergeStreamingAssistantIntoMessages(messages)),
    [mergeStreamingAssistantIntoMessages, messages],
  );

  const activeAssistantVersion = useMemo(() => {
    for (
      let groupIndex = messageGroups.length - 1;
      groupIndex >= 0;
      groupIndex -= 1
    ) {
      const group = messageGroups[groupIndex];
      if (!group || group.role !== "assistant") {
        continue;
      }

      return resolveActiveAssistantVersion({
        activeVersionByGroup,
        group,
        groups: messageGroups,
      });
    }

    return null;
  }, [activeVersionByGroup, messageGroups]);

  const activeCitations = useMemo(
    () =>
      resolveUsedCitationsForText({
        citations: activeAssistantVersion?.citations,
        text: activeAssistantVersion?.content ?? "",
      }),
    [activeAssistantVersion],
  );
  const activeAssistantCitations =
    activeAssistantVersion?.citations ?? EMPTY_CITATIONS;
  const activeAvailableCitations =
    activeAssistantVersion?.availableCitations ?? EMPTY_CITATIONS;
  const visibleCitations = useMemo(() => {
    if (activeCitations.length > 0) {
      return activeCitations;
    }
    if (activeAssistantCitations.length > 0) {
      return activeAssistantCitations;
    }
    return activeAvailableCitations;
  }, [activeAssistantCitations, activeAvailableCitations, activeCitations]);

  const threadCitations = useMemo<ThreadCitationRecord[]>(() => {
    const citationsByAnswer: ThreadCitationRecord[][] = [];
    let answerIndex = 0;

    for (const group of messageGroups) {
      if (group.role !== "assistant") {
        continue;
      }

      const version = resolveActiveAssistantVersion({
        activeVersionByGroup,
        group,
        groups: messageGroups,
      });
      if (!version) {
        continue;
      }

      answerIndex += 1;
      const usedCitations = resolveUsedCitationsForText({
        citations: version.citations,
        text: version.content,
      });
      const answerCitations =
        usedCitations.length > 0
          ? usedCitations
          : ((version.citations?.length
              ? version.citations
              : version.availableCitations) ?? EMPTY_CITATIONS);

      if (answerCitations.length === 0) {
        continue;
      }

      citationsByAnswer.push(
        answerCitations.map((citation, citationIndex) => ({
          citation,
          id: `${version.id}:${citation.chunkId}:${citationIndex}`,
          messageId: version.id,
          messageLabel: `Answer ${answerIndex}`,
        })),
      );
    }

    return citationsByAnswer.reverse().flat();
  }, [activeVersionByGroup, messageGroups]);

  useEffect(() => {
    if (!isStreaming || visibleCitations.length > 0) {
      setDisplayedCitations((current) => {
        if (
          current.length === visibleCitations.length &&
          current.every(
            (citation, index) =>
              citation.chunkId === visibleCitations[index]?.chunkId,
          )
        ) {
          return current;
        }
        return visibleCitations;
      });
    }
  }, [isStreaming, visibleCitations]);

  useEffect(() => {
    setActiveVersionByGroup((previous) => {
      const next: Record<string, number> = {};
      const nextSignatures: Record<string, string> = {};
      const pendingSelection = pendingLatestVersionSelectionRef.current;
      const appliedPendingGroups = new Set<string>();

      for (const group of messageGroups) {
        const maxIndex = Math.max(group.versions.length - 1, 0);
        const signature = `${group.groupId}:${group.latestVersionId}`;
        nextSignatures[group.groupId] = signature;

        if (
          group.groupId === pendingSelection?.userGroupId ||
          group.groupId === pendingSelection?.assistantGroupId ||
          (group.role === "assistant" &&
            group.turnId &&
            group.turnId === pendingSelection?.turnId)
        ) {
          next[group.groupId] = maxIndex;
          appliedPendingGroups.add(group.groupId);
          continue;
        }

        const hasNewVersion =
          latestSignatureByGroupRef.current[group.groupId] !== signature;

        if (hasNewVersion) {
          next[group.groupId] = maxIndex;
          continue;
        }

        const previousIndex = previous[group.groupId];
        if (typeof previousIndex !== "number") {
          next[group.groupId] = maxIndex;
          continue;
        }

        next[group.groupId] = Math.min(Math.max(previousIndex, 0), maxIndex);
      }

      if (
        pendingSelection &&
        (!pendingSelection.userGroupId ||
          appliedPendingGroups.has(pendingSelection.userGroupId)) &&
        (!pendingSelection.assistantGroupId ||
          appliedPendingGroups.has(pendingSelection.assistantGroupId)) &&
        (!pendingSelection.turnId ||
          messageGroups.some(
            (group) =>
              group.role === "assistant" &&
              group.turnId === pendingSelection.turnId &&
              appliedPendingGroups.has(group.groupId),
          ))
      ) {
        pendingLatestVersionSelectionRef.current = null;
      }

      latestSignatureByGroupRef.current = nextSignatures;
      return next;
    });
  }, [messageGroups]);

  const resetVersioningState = useCallback(() => {
    setActiveVersionByGroup({});
    setDisplayedCitations([]);
    latestSignatureByGroupRef.current = {};
  }, []);

  const handleActiveVersionChange = useCallback(
    (input: { groupId: string; branchIndex: number }) => {
      setActiveVersionByGroup((previous) => {
        const next = {
          ...previous,
          [input.groupId]: input.branchIndex,
        };

        const changedGroup = messageGroups.find(
          (group) => group.groupId === input.groupId,
        );
        if (!changedGroup) {
          return next;
        }

        if (changedGroup.role === "user") {
          const selectedUserVersion = changedGroup.versions[input.branchIndex];
          if (!selectedUserVersion) {
            return next;
          }

          for (const assistantGroup of messageGroups) {
            if (assistantGroup.role !== "assistant") {
              continue;
            }

            let latestAssistantIndexForUser: number | null = null;
            assistantGroup.versions.forEach((version, versionIndex) => {
              if (version.sourceUserMessageId === selectedUserVersion.id) {
                latestAssistantIndexForUser = versionIndex;
              }
            });

            if (latestAssistantIndexForUser !== null) {
              next[assistantGroup.groupId] = latestAssistantIndexForUser;
              break;
            }
          }

          return next;
        }

        const selectedAssistantVersion =
          changedGroup.versions[input.branchIndex];
        if (!selectedAssistantVersion?.sourceUserMessageId) {
          return next;
        }

        for (const userGroup of messageGroups) {
          if (userGroup.role !== "user") {
            continue;
          }

          const userVersionIndex = userGroup.versions.findIndex(
            (version) =>
              version.id === selectedAssistantVersion.sourceUserMessageId,
          );
          if (userVersionIndex >= 0) {
            next[userGroup.groupId] = userVersionIndex;
            break;
          }
        }

        return next;
      });
    },
    [messageGroups],
  );

  return {
    activeAssistantVersion,
    activeVersionByGroup,
    displayedCitations,
    handleActiveVersionChange,
    messageGroups,
    pendingLatestVersionSelectionRef,
    resetVersioningState,
    setActiveVersionByGroup,
    threadCitations,
  };
}
