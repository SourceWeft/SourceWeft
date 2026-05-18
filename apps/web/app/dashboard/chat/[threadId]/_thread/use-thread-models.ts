"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  resolveSelectedModelsWithByok,
  type ModelAliasSettings,
  type ModelItem,
  type ModelType,
  type SelectedModels,
} from "../../_components/model-catalog-utils";
import { writeStoredModelSelection } from "../../_components/model-selection-storage";
import {
  applySkillModelPresetState,
  DEFAULT_MODEL_SELECTION_SOURCES,
  type ModelSelectionSources,
} from "../../_components/skill-model-presets";
import {
  DEFAULT_PROMPT_THINKING_SETTINGS,
  type ChatSkillItem,
  type PromptThinkingSettings,
} from "../../_components/chat-canvas";
import { contentClient } from "../../../../../lib/sdk";
import {
  EMPTY_MODEL_KIND_FLAGS,
  getSearchPreferenceStorageKey,
  normalizeThinkingSettingsForModel,
  parseStoredThinkingSettings,
} from "./thread-storage";

type UseThreadModelsInput = {
  availableSkills: ChatSkillItem[];
  effectiveActiveSkillIds: string[];
  threadId: string;
  workspaceId: string | null;
};

export function useThreadModels({
  availableSkills,
  effectiveActiveSkillIds,
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
  const [byokProviders, setByokProviders] = useState<ByokProviderOption[]>([]);
  const [byokCredentials, setByokCredentials] = useState<ByokCredentialItem[]>([]);
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
    useState<PromptThinkingSettings>(DEFAULT_PROMPT_THINKING_SETTINGS);
  const [hasSavedThinkingPreference, setHasSavedThinkingPreference] =
    useState(false);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [loadedSearchPreferenceKey, setLoadedSearchPreferenceKey] = useState<
    string | null
  >(null);

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
    if (!workspaceId) {
      return;
    }
    if (
      !selectedModels.llm &&
      !selectedModels.image &&
      !selectedModels.vision &&
      !selectedByokModels.llm &&
      !selectedByokModels.image &&
      !selectedByokModels.vision
    ) {
      return;
    }

    writeStoredModelSelection(workspaceId, threadId, {
      llmProfileAlias:
        selectedByokModels.llm?.mode === "byok"
          ? null
          : (selectedModels.llm?.profileAlias ?? selectedModels.llm?.id ?? null),
      imageProfileAlias:
        selectedByokModels.image?.mode === "byok"
          ? null
          : (selectedModels.image?.profileAlias ??
            selectedModels.image?.id ??
            null),
      visionProfileAlias:
        selectedByokModels.vision?.mode === "byok"
          ? null
          : (selectedModels.vision?.profileAlias ??
            selectedModels.vision?.id ??
            null),
    });
  }, [selectedByokModels, selectedModels, threadId, workspaceId]);

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

  const currentThinkingStorageKey = useMemo(
    () => (workspaceId ? `chat:thinking:${workspaceId}:current` : null),
    [workspaceId],
  );
  const currentSearchStorageKey = useMemo(
    () => (workspaceId ? getSearchPreferenceStorageKey(workspaceId) : null),
    [workspaceId],
  );

  useEffect(() => {
    if (!currentThinkingStorageKey) {
      setThinkingSettings(DEFAULT_PROMPT_THINKING_SETTINGS);
      return;
    }

    const storedThinking = parseStoredThinkingSettings(
      window.sessionStorage.getItem(currentThinkingStorageKey),
    );
    setHasSavedThinkingPreference(Boolean(storedThinking));
    setThinkingSettings(storedThinking ?? DEFAULT_PROMPT_THINKING_SETTINGS);
  }, [currentThinkingStorageKey]);

  useEffect(() => {
    if (!currentSearchStorageKey) {
      setSearchEnabled(true);
      setLoadedSearchPreferenceKey(null);
      return;
    }

    const stored = window.sessionStorage.getItem(currentSearchStorageKey);
    setSearchEnabled(stored === null ? true : stored === "true");
    setLoadedSearchPreferenceKey(currentSearchStorageKey);
  }, [currentSearchStorageKey]);

  useEffect(() => {
    if (!currentThinkingStorageKey) {
      return;
    }
    window.sessionStorage.setItem(
      currentThinkingStorageKey,
      JSON.stringify(thinkingSettings),
    );
  }, [currentThinkingStorageKey, thinkingSettings]);

  useEffect(() => {
    if (
      !currentSearchStorageKey ||
      loadedSearchPreferenceKey !== currentSearchStorageKey
    ) {
      return;
    }
    window.sessionStorage.setItem(
      currentSearchStorageKey,
      searchEnabled ? "true" : "false",
    );
  }, [currentSearchStorageKey, loadedSearchPreferenceKey, searchEnabled]);

  const handleThinkingSettingsChange = useCallback(
    (settings: PromptThinkingSettings) => {
      setHasSavedThinkingPreference(true);
      setThinkingSettings(settings);
    },
    [],
  );

  const loadThreadModelState = useCallback(async () => {
    if (!workspaceId) {
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
      setStreamWithSelectedLlm(false);
      return;
    }

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
        contentClient.listThreadModelCatalog(workspaceId),
        contentClient.getThread(workspaceId, threadId),
        contentClient.listByokProviders(workspaceId).catch(() => []),
        contentClient.listByokCredentials(workspaceId).catch(() => ({
          items: [],
        })),
        contentClient.listByokModels(workspaceId).catch(() => ({
          items: [],
        })),
      ]);

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
      setStreamWithSelectedLlm(kindEnabled.llm);
    } catch {
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
      setStreamWithSelectedLlm(false);
    }
  }, [threadId, workspaceId]);

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
          ? { llmProfileAlias: input.model.profileAlias ?? input.model.id }
          : input.type === "image"
            ? { imageProfileAlias: input.model.profileAlias ?? input.model.id }
            : { visionProfileAlias: input.model.profileAlias ?? input.model.id };

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
    ({ model, selection, type }: {
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
    handleModelSelect,
    handleThreadByokSelect,
    handleThinkingSettingsChange,
    hasSavedThinkingPreference,
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
    setHasSavedThinkingPreference,
    setModelSelectionSources,
    setSearchEnabled,
    setSelectedByokModels,
    setSelectedModels,
    setStreamWithSelectedLlm,
    setThinkingSettings,
    streamWithSelectedLlm,
    thinkingSettings,
  };
}
