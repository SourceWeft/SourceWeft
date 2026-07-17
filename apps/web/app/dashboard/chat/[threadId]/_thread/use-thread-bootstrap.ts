"use client";

import { useEffect, useLayoutEffect, type RefObject } from "react";
import {
  normalizeComposerOptionsState,
  type ComposerOptionsState,
  type PromptThinkingSettings,
} from "../../_components/chat-canvas";
import {
  clearPendingThreadTurn,
  readPendingThreadTurn,
  type PendingThreadTurn,
} from "../../_components/pending-thread-turn";
import type {
  ModelItem,
  ModelType,
  SelectedModels,
} from "../../_components/model-catalog-utils";
import type { ByokModelSelection } from "../../_components/byok-state";
import { DEFAULT_MODEL_SELECTION_SOURCES } from "../../_components/skill-model-presets";
import {
  normalizeSkillIdsForRequest,
} from "../../_components/chat-canvas/tool-selection";
import type { ThreadStreamActionInput } from "./use-thread-stream-action";

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

type UseThreadBootstrapInput = {
  bootstrappedThreadKeyRef: RefObject<string | null>;
  loadThreadMessagesRef: RefObject<(() => Promise<void>) | null>;
  persistActiveSourceIds: (sourceIds: string[]) => void;
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
  useBrowserLayoutEffect(() => {
    if (!workspaceId) {
      return;
    }

    const bootstrapKey = `${workspaceId}:${threadId}`;
    if (bootstrappedThreadKeyRef.current === bootstrapKey) {
      return;
    }

    bootstrappedThreadKeyRef.current = bootstrapKey;

    const pendingTurn = readPendingThreadTurn(threadId);

    if (pendingTurn) {
      try {
        const {
          content,
          images,
          mentionedSourceIds,
          sourceIds,
          skillIds,
          tools,
          command,
          invocation,
          thinking,
          thinkingSettings: pendingThinkingSettings,
          searchEnabled: pendingSearchEnabled,
          composerOptions: pendingComposerOptions,
          modelState: pendingModelState,
        } = pendingTurn;
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
        persistActiveSourceIds(pendingSourceIds);
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
        clearPendingThreadTurn(threadId);
        void streamThreadAction({
          mode: "send",
          content,
          images: Array.isArray(images) ? images : undefined,
          mentionedSourceIds: pendingMentionedSourceIds,
          sourceIds: pendingSourceIds,
          skillIds: pendingSkillIds,
          tools,
          command,
          invocation,
          thinking,
          byokSelections:
            pendingModelState?.byokSelections ??
            (pendingModelState?.byokSelection
              ? { llm: pendingModelState.byokSelection }
              : undefined),
          searchEnabled:
            typeof pendingSearchEnabled === "boolean"
              ? pendingSearchEnabled
              : undefined,
        });
      } catch {
        clearPendingThreadTurn(threadId);
        void loadThreadMessagesRef.current?.();
      }
      return;
    }

    void loadThreadMessagesRef.current?.();
  }, [
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
}
