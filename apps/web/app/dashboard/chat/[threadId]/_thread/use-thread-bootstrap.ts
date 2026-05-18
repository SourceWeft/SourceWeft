"use client";

import { useEffect, useLayoutEffect, type RefObject } from "react";
import type {
  ChatSendInput,
  PromptThinkingSettings,
} from "../../_components/chat-canvas";
import type {
  ModelItem,
  ModelType,
  SelectedModels,
} from "../../_components/model-catalog-utils";
import type { ByokModelSelection } from "../../_components/byok-state";
import { DEFAULT_MODEL_SELECTION_SOURCES } from "../../_components/skill-model-presets";
import type { RequestThinkingConfig } from "../streaming-request-body";
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
  streamThreadActionRef: RefObject<
    ((input: ThreadStreamActionInput) => Promise<void>) | null
  >;
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
  setHasSavedThinkingPreference,
  setModelSelectionSources,
  setSearchEnabled,
  setSelectedByokModels,
  setSelectedModels,
  setStreamWithSelectedLlm,
  setThinkingSettings,
  streamThreadActionRef,
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

    const pendingKey = `chat:pending:${threadId}`;
    const raw = window.sessionStorage.getItem(pendingKey);

    if (raw) {
      window.sessionStorage.removeItem(pendingKey);
      try {
        const {
          content,
          images,
          mentionedSourceIds,
          sourceIds,
          skillIds,
          tools,
          command,
          thinking,
          thinkingSettings: pendingThinkingSettings,
          searchEnabled: pendingSearchEnabled,
          modelState: pendingModelState,
        } = JSON.parse(raw) as {
          content: string;
          images?: ChatSendInput["images"];
          mentionedSourceIds?: string[];
          sourceIds: string[];
          skillIds?: string[];
          tools?: ChatSendInput["tools"];
          command?: ChatSendInput["command"];
          thinking?: RequestThinkingConfig;
          thinkingSettings?: PromptThinkingSettings;
          searchEnabled?: boolean;
          modelState?: {
            availableModels?: Record<ModelType, ModelItem[]>;
            catalogKindEnabled?: Record<ModelType, boolean>;
            selectedModels?: SelectedModels;
            byokSelection?: ByokModelSelection | null;
            byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
          };
        };
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
          ? skillIds
              .filter(
                (skillId): skillId is string => typeof skillId === "string",
              )
              .slice(0, 5)
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
        if (pendingModelState?.availableModels) {
          setAvailableModels(pendingModelState.availableModels);
        }
        if (pendingModelState?.catalogKindEnabled) {
          setCatalogKindEnabled(pendingModelState.catalogKindEnabled);
          setStreamWithSelectedLlm(pendingModelState.catalogKindEnabled.llm);
        }
        if (pendingModelState?.selectedModels) {
          setSelectedModels(pendingModelState.selectedModels);
          setBaseSelectedModels(pendingModelState.selectedModels);
          setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
        }
        if (pendingModelState?.byokSelections) {
          setSelectedByokModels(pendingModelState.byokSelections);
        } else if (pendingModelState?.byokSelection) {
          setSelectedByokModels({ llm: pendingModelState.byokSelection });
        }
        void streamThreadActionRef.current?.({
          mode: "send",
          content,
          images: Array.isArray(images) ? images : undefined,
          mentionedSourceIds: pendingMentionedSourceIds,
          sourceIds: pendingSourceIds,
          skillIds: pendingSkillIds,
          tools,
          command,
          thinking,
          byokSelections:
            pendingModelState?.byokSelections ??
            (pendingModelState?.byokSelection
              ? { llm: pendingModelState.byokSelection }
              : undefined),
          searchEnabled: pendingSearchEnabled === true,
        });
      } catch {
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
    setHasSavedThinkingPreference,
    setModelSelectionSources,
    setSearchEnabled,
    setSelectedByokModels,
    setSelectedModels,
    setStreamWithSelectedLlm,
    setThinkingSettings,
    streamThreadActionRef,
    threadId,
    workspaceId,
  ]);
}
