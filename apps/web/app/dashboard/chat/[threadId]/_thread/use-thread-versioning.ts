"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AssistantVersionIndexEntry,
  CitationRecord,
} from "../../_components/chat-canvas";
import type { ThreadCitationRecord } from "../../_components/sources-hub";
import type { ChatMessageItem } from "../streaming-assistant-state";
import {
  buildVersionedMessageGroups,
  EMPTY_CITATIONS,
  resolveActiveAssistantVersion,
  resolveUsedCitationsForText,
  type PendingLatestVersionSelection,
} from "./message-groups";

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

type UseThreadVersioningInput = {
  isStreaming: boolean;
  mergeStreamingAssistantIntoMessages: (
    messages: ChatMessageItem[],
  ) => ChatMessageItem[];
  messages: ChatMessageItem[];
};

function reuseVersionSelection(
  previous: Record<string, number>,
  next: Record<string, number>,
) {
  const keys = Object.keys(next);
  return keys.length === Object.keys(previous).length &&
    keys.every((key) => previous[key] === next[key])
    ? previous
    : next;
}

export function useThreadVersioning({
  isStreaming,
  mergeStreamingAssistantIntoMessages,
  messages,
}: UseThreadVersioningInput) {
  const [activeVersionByGroup, setActiveVersionByGroup] = useState<
    Record<string, number>
  >({});
  // Only read committed selections from the stream effect. Depending on the
  // selection itself would immediately re-populate a reset from stale messages.
  const committedSelection = useRef(activeVersionByGroup);
  useBrowserLayoutEffect(() => {
    committedSelection.current = activeVersionByGroup;
  }, [activeVersionByGroup]);
  const [displayedCitations, setDisplayedCitations] = useState<
    CitationRecord[]
  >([]);
  const latestSignatureByGroupRef = useRef<Record<string, string>>({});
  const pendingLatestVersionSelectionRef =
    useRef<PendingLatestVersionSelection | null>(null);

  const messageGroups = useMemo(
    () =>
      buildVersionedMessageGroups(
        mergeStreamingAssistantIntoMessages(messages),
      ),
    [mergeStreamingAssistantIntoMessages, messages],
  );
  const assistantVersionById = useMemo(() => {
    const index = new Map<string, AssistantVersionIndexEntry>();
    for (const group of messageGroups) {
      if (group.role !== "assistant") {
        continue;
      }
      group.versions.forEach((version, branchIndex) => {
        index.set(version.id, {
          branchIndex,
          groupId: group.groupId,
          version,
        });
      });
    }
    return index;
  }, [messageGroups]);

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
    // Capture reconciliation inputs once. React may replay a state updater;
    // consuming these refs inside it would make a replay choose another branch.
    const pendingSelection = pendingLatestVersionSelectionRef.current;
    const previousSignatures = latestSignatureByGroupRef.current;
    const nextSignatures: Record<string, string> = {};
    const appliedPendingGroups = new Set<string>();
    const selections = messageGroups.map((group) => {
      const signature = `${group.groupId}:${group.latestVersionId}`;
      nextSignatures[group.groupId] = signature;
      const pending = Boolean(
        group.groupId === pendingSelection?.userGroupId ||
        group.groupId === pendingSelection?.assistantGroupId ||
        (group.role === "assistant" &&
          group.turnId &&
          group.turnId === pendingSelection?.turnId),
      );
      if (pending) appliedPendingGroups.add(group.groupId);
      return {
        groupId: group.groupId,
        maxIndex: Math.max(group.versions.length - 1, 0),
        selectLatest:
          pending || previousSignatures[group.groupId] !== signature,
      };
    });

    const reconcile = (previous: Record<string, number>) => {
      const next: Record<string, number> = {};
      for (const { groupId, maxIndex, selectLatest } of selections) {
        const previousIndex = previous[groupId];
        next[groupId] =
          selectLatest || typeof previousIndex !== "number"
            ? maxIndex
            : Math.min(Math.max(previousIndex, 0), maxIndex);
      }
      return reuseVersionSelection(previous, next);
    };
    // Returning the previous value from an updater can still schedule another
    // render while a stream update is pending. Skip dispatch altogether when
    // the committed selection is already valid for this message snapshot.
    if (reconcile(committedSelection.current) !== committedSelection.current) {
      setActiveVersionByGroup(reconcile);
    }

    latestSignatureByGroupRef.current = nextSignatures;
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
  }, [messageGroups]);

  const resetVersioningState = useCallback(() => {
    setActiveVersionByGroup((previous) => reuseVersionSelection(previous, {}));
    setDisplayedCitations([]);
    latestSignatureByGroupRef.current = {};
    pendingLatestVersionSelectionRef.current = null;
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
          return reuseVersionSelection(previous, next);
        }

        if (changedGroup.role === "user") {
          const selectedUserVersion = changedGroup.versions[input.branchIndex];
          if (!selectedUserVersion) {
            return reuseVersionSelection(previous, next);
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

          return reuseVersionSelection(previous, next);
        }

        const selectedAssistantVersion =
          changedGroup.versions[input.branchIndex];
        if (!selectedAssistantVersion?.sourceUserMessageId) {
          return reuseVersionSelection(previous, next);
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

        return reuseVersionSelection(previous, next);
      });
    },
    [messageGroups],
  );

  return {
    activeAssistantVersion,
    assistantVersionById,
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
