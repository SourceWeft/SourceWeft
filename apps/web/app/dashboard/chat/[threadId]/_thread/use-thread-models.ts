"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HttpClientError } from "@sourceweft/sdk";
import {
  normalizeByokProviderOptions,
  readStoredByokState,
  writeStoredByokState,
  type ByokCredentialItem,
  type ByokModelSelection,
  type ByokProviderOption,
  type ByokSavedModelItem,
} from "../../_components/byok-state";
import type { ByokModelConfigDefaults } from "../../_components/byok-model-config-dialog";
import {
  emptyModelCatalog,
  isDefaultCatalogModel,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  resolveSelectedModelsWithByok,
  type ModelAliasSettings,
  type ModelItem,
  type ModelType,
  type SelectedModels,
} from "../../_components/model-catalog-utils";
import {
  applySkillModelPresetState,
  DEFAULT_MODEL_SELECTION_SOURCES,
  type ModelSelectionSources,
} from "../../_components/skill-model-presets";
import {
  normalizeComposerOptionsState,
  type ChatSkillItem,
  type ComposerOptionsState,
  type PromptThinkingSettings,
} from "../../_components/chat-canvas";
import { contentClient } from "../../../../../lib/sdk";
import type { ThreadChatPreferences } from "@sourceweft/contracts";
import { loadThreadModelSelectorCatalog } from "../../_components/model-catalog-loader";
import {
  DEFAULT_THINKING_SETTINGS,
  EMPTY_MODEL_KIND_FLAGS,
  mapChatPreferencesToThinkingSettings,
  normalizeThinkingSettingsForModel,
} from "./thread-storage";

type UseThreadModelsInput = {
  availableSkills: ChatSkillItem[];
  effectiveActiveSkillIds: string[];
  onChatPreferencesChange?: (preferences: ThreadChatPreferences) => void;
  threadId: string;
  workspaceId: string | null;
};

export type ModelCatalogStatus = "loading" | "ready" | "error";

export function useThreadModels({
  availableSkills,
  effectiveActiveSkillIds,
  onChatPreferencesChange,
  threadId,
  workspaceId,
}: UseThreadModelsInput) {
  const [selectedModels, setSelectedModels] = useState<SelectedModels>(() =>
    resolveSelectedModels({ availableModels: emptyModelCatalog }),
  );
  const [baseSelectedModels, setBaseSelectedModels] = useState<SelectedModels>(
    () => resolveSelectedModels({ availableModels: emptyModelCatalog }),
  );
  const [modelSelectionSources, setModelSelectionSources] =
    useState<ModelSelectionSources>(DEFAULT_MODEL_SELECTION_SOURCES);
  const [availableModels, setAvailableModels] =
    useState<Record<ModelType, ModelItem[]>>(emptyModelCatalog);
  const [modelCatalogStatus, setModelCatalogStatus] =
    useState<ModelCatalogStatus>("loading");
  const [byokProviders, setByokProviders] = useState<ByokProviderOption[]>([]);
  const [byokCredentials, setByokCredentials] = useState<ByokCredentialItem[]>(
    [],
  );
  const [byokModels, setByokModels] = useState<ByokSavedModelItem[]>([]);
  const [selectedByokModels, setSelectedByokModels] = useState<
    Partial<Record<ModelType, ByokModelSelection | null>>
  >({});
  const [loadedByokStorageKey, setLoadedByokStorageKey] = useState<
    string | null
  >(null);
  const [byokModelConfig, setByokModelConfig] =
    useState<ByokModelConfigDefaults | null>(null);
  const [catalogKindEnabled, setCatalogKindEnabled] = useState<
    Record<ModelType, boolean>
  >(EMPTY_MODEL_KIND_FLAGS);
  const [streamWithSelectedLlm, setStreamWithSelectedLlm] = useState(false);
  const [thinkingSettings, setThinkingSettings] =
    useState<PromptThinkingSettings>(DEFAULT_THINKING_SETTINGS);
  const [hasSavedThinkingPreference, setHasSavedThinkingPreference] =
    useState(false);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [composerOptions, setComposerOptions] = useState<ComposerOptionsState>(
    () => normalizeComposerOptionsState({}),
  );
  const modelLoadGenerationRef = useRef(0);

  useEffect(() => {
    if (!workspaceId) {
      setLoadedByokStorageKey(null);
      setSelectedByokModels({});
      return;
    }
    const stored = readStoredByokState(workspaceId, threadId);
    setLoadedByokStorageKey(`${workspaceId}:${threadId}`);
    setSelectedByokModels({
      image: stored?.imageByok ?? null,
      llm: stored?.llmByok ?? null,
      vision: stored?.visionByok ?? null,
    });
  }, [threadId, workspaceId]);

  useEffect(() => {
    setThinkingSettings((current) =>
      normalizeThinkingSettingsForModel({
        capabilities: selectedModels.llm?.capabilities,
        hasSavedPreference: hasSavedThinkingPreference,
        settings: current,
      }),
    );
  }, [hasSavedThinkingPreference, selectedModels.llm]);

  useEffect(() => {
    if (!workspaceId) {
      setLoadedByokStorageKey(null);
      return;
    }
    if (loadedByokStorageKey !== `${workspaceId}:${threadId}`) {
      return;
    }
    writeStoredByokState(
      workspaceId,
      {
        imageByok: selectedByokModels.image ?? null,
        llmByok: selectedByokModels.llm ?? null,
        visionByok: selectedByokModels.vision ?? null,
      },
      threadId,
    );
  }, [loadedByokStorageKey, selectedByokModels, threadId, workspaceId]);

  useEffect(() => {
    if (selectedByokModels.llm?.mode === "byok") {
      return;
    }
    const next = applySkillModelPresetState({
      activeSkillIds: effectiveActiveSkillIds,
      availableModels,
      availableSkills,
      baseSelectedModels,
      selectedModels,
      selectionSources: modelSelectionSources,
    });
    if (next.modelsChanged) {
      setSelectedModels(next.nextModels);
      if (next.nextSources.llm === "skill" && catalogKindEnabled.llm) {
        setStreamWithSelectedLlm(true);
      }
    }
    if (next.sourcesChanged) {
      setModelSelectionSources(next.nextSources);
      if (
        next.nextSources.llm === "system" &&
        modelSelectionSources.llm === "skill"
      ) {
        setStreamWithSelectedLlm(catalogKindEnabled.llm);
      }
    }
  }, [
    effectiveActiveSkillIds,
    availableModels,
    availableSkills,
    baseSelectedModels,
    catalogKindEnabled.llm,
    modelSelectionSources,
    selectedByokModels.llm,
    selectedModels,
  ]);

  const handleThinkingSettingsChange = useCallback(
    (settings: PromptThinkingSettings) => {
      setHasSavedThinkingPreference(true);
      setThinkingSettings(settings);
      if (!workspaceId) {
        return;
      }
      void contentClient
        .updateThreadChatPreferences(workspaceId, threadId, {
          thinking: settings,
        })
        .then((result) => {
          onChatPreferencesChange?.(result.thread.chatPreferences);
        })
        .catch(() => {
          toast.error("Failed to save Thinking preference for this chat.");
        });
    },
    [onChatPreferencesChange, threadId, workspaceId],
  );

  const handleSearchEnabledChange = useCallback(
    (enabled: boolean) => {
      setSearchEnabled(enabled);
      if (!workspaceId) {
        return;
      }
      void contentClient
        .updateThreadChatPreferences(workspaceId, threadId, {
          webAccess: enabled,
        })
        .then((result) => {
          onChatPreferencesChange?.(result.thread.chatPreferences);
        })
        .catch(() => {
          toast.error("Failed to save web access preference for this chat.");
        });
    },
    [onChatPreferencesChange, threadId, workspaceId],
  );

  const handleComposerOptionsChange = useCallback(
    (options: ComposerOptionsState) => {
      const nextOptions = normalizeComposerOptionsState(options);
      setComposerOptions(nextOptions);
      if (!workspaceId) {
        return;
      }
      void contentClient
        .updateThreadChatPreferences(workspaceId, threadId, {
          composerOptions: nextOptions,
        })
        .then((result) => {
          onChatPreferencesChange?.(result.thread.chatPreferences);
        })
        .catch(() => {
          toast.error("Failed to save options for this chat.");
        });
    },
    [onChatPreferencesChange, threadId, workspaceId],
  );

  const loadThreadModelState = useCallback(async () => {
    const loadGeneration = modelLoadGenerationRef.current + 1;
    modelLoadGenerationRef.current = loadGeneration;
    const isStaleLoad = () => modelLoadGenerationRef.current !== loadGeneration;

    if (!workspaceId) {
      setModelCatalogStatus("loading");
      setAvailableModels(emptyModelCatalog);
      const emptySelection = resolveSelectedModels({
        availableModels: emptyModelCatalog,
      });
      setSelectedModels(emptySelection);
      setBaseSelectedModels(emptySelection);
      setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      setByokProviders([]);
      setByokCredentials([]);
      setByokModels([]);
      setSelectedByokModels({});
      setComposerOptions(normalizeComposerOptionsState({}));
      setStreamWithSelectedLlm(false);
      return;
    }

    setModelCatalogStatus("loading");
    setStreamWithSelectedLlm(false);
    const stored = readStoredByokState(workspaceId, threadId);
    const storedByokSelections = {
      image: stored?.imageByok ?? null,
      llm: stored?.llmByok ?? null,
      vision: stored?.visionByok ?? null,
    } satisfies Partial<Record<ModelType, ByokModelSelection | null>>;

    try {
      const [
        catalog,
        threadResponse,
        providerResult,
        credentialResult,
        modelResult,
      ] = await Promise.all([
        loadThreadModelSelectorCatalog(workspaceId),
        contentClient.getThread(workspaceId, threadId),
        contentClient.listByokProviders(workspaceId).catch(() => []),
        contentClient.listByokCredentials(workspaceId).catch(() => ({
          items: [],
        })),
        contentClient.listByokModels(workspaceId).catch(() => ({
          items: [],
        })),
      ]);

      if (isStaleLoad()) {
        return;
      }

      const catalogModels = mapCatalogKindsToModelItems(catalog.kinds);
      const kindEnabled = {
        llm: catalogModels.llm.length > 0,
        image: catalogModels.image.length > 0,
        vision: catalogModels.vision.length > 0,
      } satisfies Record<ModelType, boolean>;

      setCatalogKindEnabled(kindEnabled);
      setAvailableModels(catalogModels);
      const resolvedModels = resolveSelectedModels({
        availableModels: catalogModels,
        threadAliases: threadResponse.thread.modelSettings,
        fallbackAliases: catalog.defaults,
      });
      setSelectedModels(
        resolveSelectedModelsWithByok({
          availableModels: catalogModels,
          baseSelectedModels: resolvedModels,
          byokSelections: storedByokSelections,
        }),
      );
      setBaseSelectedModels(resolvedModels);
      setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
      setByokCredentials(credentialResult.items);
      setByokModels(modelResult.items);
      setSelectedByokModels(storedByokSelections);
      setByokProviders(
        normalizeByokProviderOptions(providerResult, credentialResult.items),
      );
      setHasSavedThinkingPreference(
        threadResponse.thread.chatPreferences.thinking.mode === "off" ||
          threadResponse.thread.chatPreferences.thinking.mode === "effort",
      );
      setThinkingSettings(
        mapChatPreferencesToThinkingSettings(
          threadResponse.thread.chatPreferences,
        ),
      );
      setSearchEnabled(threadResponse.thread.chatPreferences.webAccess);
      setComposerOptions(
        normalizeComposerOptionsState(
          threadResponse.thread.chatPreferences.composerOptions,
        ),
      );
      onChatPreferencesChange?.(threadResponse.thread.chatPreferences);
      setStreamWithSelectedLlm(kindEnabled.llm);
      setModelCatalogStatus("ready");
    } catch {
      if (isStaleLoad()) {
        return;
      }

      setModelCatalogStatus("error");
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      setAvailableModels(emptyModelCatalog);
      const emptySelection = resolveSelectedModels({
        availableModels: emptyModelCatalog,
      });
      setSelectedModels(emptySelection);
      setBaseSelectedModels(emptySelection);
      setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
      setByokProviders([]);
      setByokCredentials([]);
      setByokModels([]);
      setSelectedByokModels({});
      setComposerOptions(normalizeComposerOptionsState({}));
      setStreamWithSelectedLlm(false);
    }
  }, [onChatPreferencesChange, threadId, workspaceId]);

  useEffect(() => {
    void loadThreadModelState();
  }, [loadThreadModelState]);

  const handleModelSelect = useCallback(
    async (input: { type: ModelType; model: ModelItem }) => {
      setModelSelectionSources((current) => ({
        ...current,
        [input.type]: "user",
      }));
      setSelectedByokModels((current) => ({
        ...current,
        [input.type]: null,
      }));
      if (!workspaceId || !catalogKindEnabled[input.type]) {
        return;
      }

      const patch: ModelAliasSettings =
        input.type === "llm"
          ? {
              llmProfileAlias: isDefaultCatalogModel(input.model)
                ? null
                : (input.model.profileAlias ?? input.model.id),
            }
          : input.type === "image"
            ? {
                imageProfileAlias: isDefaultCatalogModel(input.model)
                  ? null
                  : (input.model.profileAlias ?? input.model.id),
              }
            : {
                visionProfileAlias: isDefaultCatalogModel(input.model)
                  ? null
                  : (input.model.profileAlias ?? input.model.id),
              };

      try {
        await contentClient.updateThreadModelSettings(
          workspaceId,
          threadId,
          patch,
        );
        if (input.type === "llm") {
          setThinkingSettings((current) =>
            normalizeThinkingSettingsForModel({
              capabilities: input.model.capabilities,
              hasSavedPreference: hasSavedThinkingPreference,
              settings: current,
            }),
          );
          setStreamWithSelectedLlm(true);
        }
      } catch (error) {
        if (error instanceof HttpClientError) {
          const detailMessage =
            typeof error.details?.message === "string"
              ? error.details.message
              : undefined;
          const message = detailMessage || error.message || error.code;
          toast.error(`Failed to update model for this thread: ${message}`);
        } else {
          toast.error("Failed to update model for this thread.");
        }
        await loadThreadModelState();
      }
    },
    [
      catalogKindEnabled,
      hasSavedThinkingPreference,
      loadThreadModelState,
      threadId,
      workspaceId,
    ],
  );

  const handleThreadByokSelect = useCallback(
    ({
      model,
      selection,
      type,
    }: {
      model: ModelItem;
      selection: ByokModelSelection;
      type: ModelType;
    }) => {
      setModelSelectionSources((current) => ({
        ...current,
        [type]: "user",
      }));
      setSelectedModels((current) => ({
        ...current,
        [type]: model,
      }));
      setSelectedByokModels((current) => ({
        ...current,
        [type]: selection,
      }));
      if (type === "llm") {
        setThinkingSettings((current) =>
          normalizeThinkingSettingsForModel({
            capabilities: model.capabilities,
            hasSavedPreference: hasSavedThinkingPreference,
            settings: current,
          }),
        );
        setStreamWithSelectedLlm(true);
      }
    },
    [hasSavedThinkingPreference],
  );

  return {
    availableModels,
    baseSelectedModels,
    byokCredentials,
    byokModelConfig,
    byokModels,
    byokProviders,
    catalogKindEnabled,
    composerOptions,
    handleModelSelect,
    handleComposerOptionsChange,
    handleThreadByokSelect,
    handleSearchEnabledChange,
    handleThinkingSettingsChange,
    hasSavedThinkingPreference,
    modelCatalogStatus,
    modelSelectionSources,
    searchEnabled,
    selectedByokModels,
    selectedModels,
    setAvailableModels,
    setBaseSelectedModels,
    setByokCredentials,
    setByokModelConfig,
    setByokModels,
    setByokProviders,
    setCatalogKindEnabled,
    setComposerOptions,
    setHasSavedThinkingPreference,
    setModelSelectionSources,
    setSearchEnabled: handleSearchEnabledChange,
    setSelectedByokModels,
    setSelectedModels,
    setStreamWithSelectedLlm,
    setThinkingSettings,
    streamWithSelectedLlm,
    thinkingSettings,
  };
}
