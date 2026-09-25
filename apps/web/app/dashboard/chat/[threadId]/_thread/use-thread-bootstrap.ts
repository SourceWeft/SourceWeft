"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslations } from "next-intl";
import {
  normalizeComposerOptionsState,
  type ComposerOptionsState,
  type PromptThinkingSettings,
} from "../../_components/chat-canvas";
import {
  createPendingThreadRunKey,
  clearPendingThreadTurn,
  readPendingThreadTurn,
  hydratePendingThreadTurn,
  setPendingThreadTurn,
  writePendingThreadTurnFallback,
  type PendingThreadTurn,
} from "../../_components/pending-thread-turn";
import type {
  ModelItem,
  ModelType,
  SelectedModels,
} from "../../_components/model-catalog-utils";
import type { ByokModelSelection } from "../../_components/byok-state";
import { DEFAULT_MODEL_SELECTION_SOURCES } from "../../_components/skill-model-presets";
import { normalizeSkillIdsForRequest } from "../../_components/chat-canvas/tool-selection";
import type { ThreadStreamActionInput } from "./use-thread-stream-action";

import { useLocalConversationStatus } from "../../_components/local-conversation-status";
import { checkingConversation } from "../../../../../lib/local-conversation-store";

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

type UseThreadBootstrapInput = {
  userId: string | null;
  bootstrappedThreadKeyRef: RefObject<string | null>;
  loadThreadMessagesRef: RefObject<(() => Promise<void>) | null>;
  persistActiveSourceIds: (sourceIds: string[]) => void | Promise<boolean>;
  setActiveSkillIds: (skillIds: string[]) => void;
  setAvailableModels: (models: Record<ModelType, ModelItem[]>) => void;
  setBaseSelectedModels: (models: SelectedModels) => void;
  setCatalogKindEnabled: (enabled: Record<ModelType, boolean>) => void;
  setComposerOptions: (options: ComposerOptionsState) => void;
  setHasSavedThinkingPreference: (hasSavedPreference: boolean) => void;
  setModelSelectionSources: (
    sources: typeof DEFAULT_MODEL_SELECTION_SOURCES,
  ) => void;
  setSearchEnabled: (enabled: boolean) => void;
  setSelectedByokModels: (
    selections: Partial<Record<ModelType, ByokModelSelection | null>>,
  ) => void;
  setSelectedModels: (models: SelectedModels) => void;
  setStreamWithSelectedLlm: (streamWithSelectedLlm: boolean) => void;
  setThinkingSettings: (settings: PromptThinkingSettings) => void;
  streamThreadAction: (input: ThreadStreamActionInput) => Promise<void>;
  threadId: string;
  workspaceId: string | null;
};

export function useThreadBootstrap({
  userId,
  bootstrappedThreadKeyRef,
  loadThreadMessagesRef,
  persistActiveSourceIds,
  setActiveSkillIds,
  setAvailableModels,
  setBaseSelectedModels,
  setCatalogKindEnabled,
  setComposerOptions,
  setHasSavedThinkingPreference,
  setModelSelectionSources,
  setSearchEnabled,
  setSelectedByokModels,
  setSelectedModels,
  setStreamWithSelectedLlm,
  setThinkingSettings,
  streamThreadAction,
  threadId,
  workspaceId,
}: UseThreadBootstrapInput) {
  const t = useTranslations("dashboardChat");
  const localStatus = useLocalConversationStatus(workspaceId, threadId);
  const scope = JSON.stringify([userId, workspaceId, threadId]);
  const activeScope = useRef(scope);
  useBrowserLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = "";
    };
  }, [scope]);
  const initializedScope = useRef<string | null>(null);
  const [prepared, setPrepared] = useState<{
    scope: string;
    turn: PendingThreadTurn;
  } | null>(null);
  const [recovery, setRecovery] = useState<{
    scope: string;
    message: string;
    turn: PendingThreadTurn;
  } | null>(null);
  const sending = useRef<string | null>(null);
  const [retry, setRetry] = useState(0);
  const currentTurn = prepared?.scope === scope ? prepared.turn : null;
  const save = useCallback(
    (turn: PendingThreadTurn) => {
      setPendingThreadTurn(threadId, turn);
      try {
        writePendingThreadTurnFallback(threadId, turn);
        return true;
      } catch (error) {
        if (activeScope.current === scope)
          setRecovery({
            scope,
            turn,
            message: error instanceof Error ? error.message : String(error),
          });
        return false;
      }
    },
    [threadId, scope],
  );
  useEffect(() => {
    if (
      !currentTurn ||
      !localStatus.ready ||
      sending.current === scope ||
      currentTurn.requiresRetry
    )
      return;
    sending.current = scope;
    const turn = {
      ...currentTurn,
      durableRunKey: currentTurn.durableRunKey ?? createPendingThreadRunKey(),
      requiresRetry: true,
    };
    if (!save(turn)) return;
    let accepted = false;
    let failureMessage: string | null = null;
    const recover = (message: string) => {
      if (accepted) return;
      failureMessage = message;
      if (activeScope.current === scope) setRecovery({ scope, turn, message });
    };
    void streamThreadAction({
      mode: "send",
      ...turn,
      byokSelections:
        turn.modelState?.byokSelections ??
        (turn.modelState?.byokSelection
          ? { llm: turn.modelState.byokSelection }
          : undefined),
      onAccepted: () => {
        accepted = true;
        clearPendingThreadTurn(threadId);
        if (activeScope.current === scope) {
          setRecovery(null);
          setPrepared(null);
        }
      },
      onBlocked: recover,
    })
      .catch((error) =>
        recover(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        if (!accepted)
          recover(
            failureMessage ?? t("bootstrap.firstMessageNotConfirmed"),
          );
      });
  }, [
    save,
    currentTurn,
    localStatus.ready,
    scope,
    streamThreadAction,
    threadId,
    retry,
    t,
  ]);
  useEffect(() => {
    if (
      !currentTurn ||
      currentTurn.requiresRetry ||
      localStatus.ready ||
      localStatus.message === checkingConversation.message
    )
      return;
    const turn = { ...currentTurn, requiresRetry: true };
    save(turn);
    setRecovery({
      scope,
      turn,
      message:
        localStatus.message ?? t("bootstrap.computerUnavailableSaved"),
    });
    setPrepared({ scope, turn });
  }, [localStatus.ready, localStatus.message, scope, currentTurn, save, t]);

  useBrowserLayoutEffect(() => {
    if (!workspaceId || !userId) {
      return;
    }

    const bootstrapKey = `${workspaceId}:${threadId}`;
    if (initializedScope.current === scope) {
      return;
    }

    bootstrappedThreadKeyRef.current = bootstrapKey;
    initializedScope.current = scope;

    const pendingTurn = readPendingThreadTurn(threadId);
    if (
      pendingTurn &&
      ((pendingTurn.userId && pendingTurn.userId !== userId) ||
        (pendingTurn.workspaceId && pendingTurn.workspaceId !== workspaceId))
    ) {
      void loadThreadMessagesRef.current?.();
      return;
    }

    if (pendingTurn) {
      void (async () => {
        try {
          const hydratedTurn = await hydratePendingThreadTurn(pendingTurn);
          if (activeScope.current !== scope) return;
          const {
            mentionedSourceIds,
            sourceIds,
            skillIds,
            thinkingSettings: pendingThinkingSettings,
            searchEnabled: pendingSearchEnabled,
            composerOptions: pendingComposerOptions,
            modelState: pendingModelState,
          } = hydratedTurn;
          const pendingSourceIds = Array.isArray(sourceIds)
            ? sourceIds.filter(
                (sourceId): sourceId is string => typeof sourceId === "string",
              )
            : [];
          const pendingMentionedSourceIds = Array.isArray(mentionedSourceIds)
            ? mentionedSourceIds.filter(
                (sourceId): sourceId is string => typeof sourceId === "string",
              )
            : [];
          const pendingSkillIds = Array.isArray(skillIds)
            ? normalizeSkillIdsForRequest(
                skillIds.filter(
                  (skillId): skillId is string => typeof skillId === "string",
                ),
              )
            : [];
          if ((await persistActiveSourceIds(pendingSourceIds)) === false) {
            throw new Error(t("bootstrap.saveSourcesFailed"));
          }
          if (activeScope.current !== scope) return;
          setActiveSkillIds(pendingSkillIds);
          if (pendingThinkingSettings) {
            setHasSavedThinkingPreference(true);
            setThinkingSettings(pendingThinkingSettings);
          }
          if (typeof pendingSearchEnabled === "boolean") {
            setSearchEnabled(pendingSearchEnabled);
          }
          if (pendingComposerOptions) {
            setComposerOptions(
              normalizeComposerOptionsState(pendingComposerOptions),
            );
          }
          if (
            pendingModelState?.catalogReady &&
            pendingModelState.availableModels
          ) {
            setAvailableModels(pendingModelState.availableModels);
          }
          if (
            pendingModelState?.catalogReady &&
            pendingModelState.catalogKindEnabled
          ) {
            setCatalogKindEnabled(pendingModelState.catalogKindEnabled);
            setStreamWithSelectedLlm(pendingModelState.catalogKindEnabled.llm);
          }
          if (
            pendingModelState?.catalogReady &&
            pendingModelState.selectedModels
          ) {
            setSelectedModels(pendingModelState.selectedModels);
            setBaseSelectedModels(pendingModelState.selectedModels);
            setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
          }
          if (pendingModelState?.byokSelections) {
            setSelectedByokModels(pendingModelState.byokSelections);
          } else if (pendingModelState?.byokSelection) {
            setSelectedByokModels({ llm: pendingModelState.byokSelection });
          }
          await loadThreadMessagesRef.current?.();
          if (activeScope.current !== scope) return;
          setPrepared({
            scope,
            turn: {
              ...hydratedTurn,
              sourceIds: pendingSourceIds,
              mentionedSourceIds: pendingMentionedSourceIds,
              skillIds: pendingSkillIds,
            },
          });
          if (pendingTurn.requiresRetry)
            setRecovery({
              scope,
              turn: pendingTurn,
              message: t("bootstrap.firstMessageSavedCheck"),
            });
        } catch (error) {
          if (activeScope.current !== scope) return;
          const turn = { ...pendingTurn, requiresRetry: true };
          save(turn);
          await loadThreadMessagesRef.current?.();
          if (activeScope.current !== scope) return;
          setRecovery({
            scope,
            turn,
            message: error instanceof Error ? error.message : String(error),
          });
          setPrepared({ scope, turn });
        }
      })();
      return;
    }

    void loadThreadMessagesRef.current?.();
  }, [
    scope,
    save,
    retry,
    userId,
    bootstrappedThreadKeyRef,
    loadThreadMessagesRef,
    persistActiveSourceIds,
    setActiveSkillIds,
    setAvailableModels,
    setBaseSelectedModels,
    setCatalogKindEnabled,
    setComposerOptions,
    setHasSavedThinkingPreference,
    setModelSelectionSources,
    setSearchEnabled,
    setSelectedByokModels,
    setSelectedModels,
    setStreamWithSelectedLlm,
    setThinkingSettings,
    streamThreadAction,
    threadId,
    workspaceId,
  ]);
  return {
    recovery: recovery?.scope === scope ? recovery : null,
    retry: async () => {
      if (!recovery || recovery.scope !== scope || !localStatus.ready) return;
      await loadThreadMessagesRef.current?.();
      if (activeScope.current !== scope) return;
      const turn = { ...recovery.turn, requiresRetry: false };
      if (!save(turn)) return;
      sending.current = null;
      setRecovery(null);
      // Re-prepare Sources and model settings using the current scope before retrying.
      bootstrappedThreadKeyRef.current = null;
      initializedScope.current = null;
      setPrepared(null);
      setRetry((value) => value + 1);
    },
  };
}
