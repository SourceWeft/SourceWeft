"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { useDashboardChatState } from "../_components/dashboard-chat-state";
import {
  emptyModelCatalog,
  HeaderModelSelector,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  resolveSelectedModelsWithByok,
  type ModelAliasSettings,
  type ModelItem,
  type SelectedModels,
  type ModelType,
} from "./_components/header-model-selector";
import {
  buildByokModelExecution,
  buildThreadCreateModelSettings,
  normalizeByokProviderOptions,
  readStoredByokState,
  writeStoredByokState,
  type ByokCredentialItem,
  type ByokModelSelection,
  type ByokProviderOption,
  type ByokSavedModelItem,
} from "./_components/byok-state";
import {
  ByokModelConfigDialog,
  type ByokModelConfigDefaults,
} from "./_components/byok-model-config-dialog";
import {
  applySkillModelPresetState,
  DEFAULT_MODEL_SELECTION_SOURCES,
  type ModelSelectionSources,
} from "./_components/skill-model-presets";
import {
  buildChatToolsRequest,
  ChatCanvas,
  DEFAULT_PROMPT_THINKING_SETTINGS,
  type ArtifactPreviewRecord,
  type ChatSendInput,
  type ChatSkillItem,
  type ChatToolName,
  type PromptInputMentionSourceLoader,
  type PromptThinkingSettings,
} from "./_components/chat-canvas";
import { AGENT_TOOL_NAMES } from "@sourceweft/sdk";
import {
  ArtifactPreviewPanel,
  SourcesHub,
  type ArtifactListItem,
} from "./_components/sources-hub";
import {
  expandSelectedSources,
  type SourceItem,
} from "./_components/source-types";
import {
  readStoredSourceSelection,
  writeStoredSourceSelection,
} from "./_components/source-selection-storage";
import {
  readStoredModelSelection,
  writeStoredModelSelection,
} from "./_components/model-selection-storage";
import {
  getCachedWorkspaceSources,
  hasCachedWorkspaceSources,
  setCachedWorkspaceSources,
} from "./_components/source-library-cache";
import {
  desktopBridge,
  handleDesktopAuthDeepLink,
} from "../../../lib/desktop-bridge";
import { contentClient } from "../../../lib/sdk";

const EMPTY_MODEL_KIND_FLAGS: Record<ModelType, boolean> = {
  llm: false,
  image: false,
  vision: false,
};
const SEARCH_PREFERENCE_STORAGE_VERSION = "v2";
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function mergeSourceIds(...sourceIdGroups: (string[] | undefined)[]) {
  return [
    ...new Set(
      sourceIdGroups.flatMap((sourceIds) => sourceIds ?? []).filter(Boolean),
    ),
  ];
}

function getSearchPreferenceStorageKey(workspaceId: string) {
  return `chat:search:${SEARCH_PREFERENCE_STORAGE_VERSION}:${workspaceId}:current`;
}

function removeDisabledToolSkills(input: {
  skillIds: string[];
  availableSkills: ChatSkillItem[];
  disabledToolNames: ChatToolName[];
}) {
  if (input.disabledToolNames.length === 0) {
    return input.skillIds;
  }
  const disabledToolNameSet = new Set(input.disabledToolNames);
  return input.skillIds.filter((skillId) => {
    const skill = input.availableSkills.find((item) => item.id === skillId);
    return !skill?.tools?.some((toolName) =>
      disabledToolNameSet.has(toolName as ChatToolName),
    );
  });
}

function parseStoredThinkingSettings(
  value: string | null,
): PromptThinkingSettings | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<PromptThinkingSettings>;
    const mode = parsed.mode;
    const effort = parsed.effort;
    if (mode !== "auto" && mode !== "off" && mode !== "effort") {
      return null;
    }
    if (
      effort !== "minimal" &&
      effort !== "low" &&
      effort !== "medium" &&
      effort !== "high" &&
      effort !== "xhigh"
    ) {
      return null;
    }
    return { mode, effort };
  } catch {
    return null;
  }
}

function buildPendingThinking(input: {
  capabilities: ModelItem["capabilities"] | undefined;
  settings: PromptThinkingSettings;
}) {
  if (input.capabilities?.supportsThinking !== true) {
    return undefined;
  }

  if (input.settings.mode === "off") {
    return {
      mode: "off",
      enabled: false,
      includeReasoning: false,
    };
  }

  if (input.settings.mode === "effort") {
    if (
      !(input.capabilities?.supportedEfforts ?? []).includes(
        input.settings.effort,
      )
    ) {
      return {
        mode: "auto",
      };
    }

    return {
      mode: "effort",
      enabled: true,
      effort: input.settings.effort,
      includeReasoning: true,
    };
  }

  return {
    mode: "auto",
  };
}

function normalizeThinkingSettingsForModel(input: {
  capabilities: ModelItem["capabilities"] | undefined;
  hasSavedPreference?: boolean;
  settings: PromptThinkingSettings;
}): PromptThinkingSettings {
  if (
    input.capabilities?.supportsThinking === true &&
    input.settings.mode === "off" &&
    input.hasSavedPreference !== true
  ) {
    return {
      ...input.settings,
      mode: "auto",
    };
  }

  if (input.settings.mode !== "effort") {
    return input.settings;
  }

  if (
    (input.capabilities?.supportedEfforts ?? []).includes(input.settings.effort)
  ) {
    return input.settings;
  }

  return {
    ...input.settings,
    mode: "auto",
  };
}

export default function DashboardChatPage() {
  const router = useRouter();
  const {
    createChat,
    sourcesVisible,
    startNewChat,
    toggleSourcesVisible,
    workspaceId,
    workspaceName,
  } = useDashboardChatState();

  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<ChatSkillItem[]>([]);
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const [disabledToolNames, setDisabledToolNames] = useState<ChatToolName[]>([]);
  const [previewArtifact, setPreviewArtifact] =
    useState<ArtifactListItem | null>(null);
  const isDesktopPanel = useMediaQuery("(min-width: 1024px)");
  const skillsLoadGenerationRef = useRef(0);
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
  const [thinkingSettings, setThinkingSettings] =
    useState<PromptThinkingSettings>(DEFAULT_PROMPT_THINKING_SETTINGS);
  const [hasSavedThinkingPreference, setHasSavedThinkingPreference] =
    useState(false);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [loadedSearchPreferenceKey, setLoadedSearchPreferenceKey] = useState<
    string | null
  >(null);
  const handleArtifactPreview = useCallback(
    (artifact: ArtifactPreviewRecord) => {
      setPreviewArtifact(artifact);
      if (!sourcesVisible) {
        toggleSourcesVisible();
      }
    },
    [sourcesVisible, toggleSourcesVisible],
  );
  const loadSourceMentions = useCallback<PromptInputMentionSourceLoader>(
    async ({ cursor, limit, query }) => {
      if (!workspaceId) {
        return { items: [], nextCursor: null };
      }

      const result = await contentClient.listSourceMentions(workspaceId, {
        cursor: cursor ?? undefined,
        limit,
        query: query || undefined,
      });
      return {
        items: result.items.map((source) => ({
          id: source.id,
          meta:
            source.status === "failed"
              ? "Processing failed"
              : source.status === "queued" || source.status === "processing"
                ? "Sync in progress"
                : new Date(source.updatedAt).toLocaleString(),
          title: source.title || "Untitled",
          type: source.mimeType ?? source.sourceType,
        })),
        nextCursor: result.nextCursor,
      };
    },
    [workspaceId],
  );

  useBrowserLayoutEffect(() => {
    startNewChat();
  }, [startNewChat]);

  useEffect(() => {
    setLibrarySources(getCachedWorkspaceSources(workspaceId) ?? []);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setLoadedByokStorageKey(null);
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
      return;
    }

    const stored = readStoredByokState(workspaceId);
    setLoadedByokStorageKey(workspaceId);
    const storedByokSelections = {
      image: stored?.imageByok ?? null,
      llm: stored?.llmByok ?? null,
      vision: stored?.visionByok ?? null,
    } satisfies Partial<Record<ModelType, ByokModelSelection | null>>;
    setSelectedByokModels(storedByokSelections);

    const activeWorkspaceId = workspaceId;

    let cancelled = false;

    async function loadModelCatalog() {
      try {
        const [catalog, providerResult, credentialResult, modelResult] = await Promise.all([
          contentClient.listThreadModelCatalog(activeWorkspaceId),
          contentClient.listByokProviders(activeWorkspaceId).catch(() => []),
          contentClient.listByokCredentials(activeWorkspaceId).catch(() => ({
            items: [],
          })),
          contentClient.listByokModels(activeWorkspaceId).catch(() => ({
            items: [],
          })),
        ]);
        if (cancelled) {
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
        const storedModelSelection = readStoredModelSelection(
          activeWorkspaceId,
          "current",
        );
        const resolvedModels = resolveSelectedModels({
          availableModels: catalogModels,
          threadAliases: storedModelSelection ?? undefined,
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
        setByokProviders(
          normalizeByokProviderOptions(providerResult, credentialResult.items),
        );
      } catch {
        if (cancelled) {
          return;
        }

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
      }
    }

    void loadModelCatalog();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!desktopBridge.isAvailable()) {
      return;
    }

    const cleanupTask = desktopBridge.onDeepLink((payload) => {
      const url = payload.url.trim();
      if (!url) {
        return;
      }

      void handleDesktopAuthDeepLink({
        url,
        onSuccess: () => {
          router.replace("/dashboard");
          router.refresh();
        },
        onError: (message) => toast.error(message),
      }).then((handled) => {
        if (handled) {
          return;
        }
      });
    });

    return () => {
      cleanupTask.then((cleanup) => void cleanup()).catch(() => {});
    };
  }, [router]);

  const loadAvailableSkills = useCallback(async () => {
    const loadGeneration = ++skillsLoadGenerationRef.current;
    if (!workspaceId) {
      setAvailableSkills([]);
      setActiveSkillIds([]);
      return;
    }

    const activeWorkspaceId = workspaceId;
    try {
      const result = await contentClient.listSkillsCatalog(activeWorkspaceId);
      if (
        skillsLoadGenerationRef.current !== loadGeneration ||
        activeWorkspaceId !== workspaceId
      ) {
        return;
      }
      const enabledSkills = result.items
        .filter((skill) => skill.enabled && skill.enabledWorkspaceSkillId)
        .map((skill) => ({
          id: skill.enabledWorkspaceSkillId as string,
          catalogId: skill.catalogId,
          slug: skill.slug,
          name: skill.name,
          displayName: skill.displayName,
          description: skill.description,
          sourceType: skill.sourceType,
          version: skill.version,
          hasReadme: skill.hasReadme,
          capabilities: skill.capabilities,
          models: skill.models,
          tools: skill.tools,
          slash: skill.slash,
          slashConfig: skill.slashConfig,
          commands: skill.commands,
          defaultConfig: skill.defaultConfig,
        }));
      setAvailableSkills(enabledSkills);

      const enabledIds = new Set(enabledSkills.map((skill) => skill.id));
      setActiveSkillIds((current) =>
        current.filter((id) => enabledIds.has(id)).slice(0, 5),
      );
    } catch {
      if (skillsLoadGenerationRef.current !== loadGeneration) {
        return;
      }
      setAvailableSkills([]);
      setActiveSkillIds([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadAvailableSkills();
  }, [loadAvailableSkills]);

  useEffect(() => {
    if (!workspaceId) {
      setActiveSourceIds([]);
      return;
    }

    setActiveSourceIds(readStoredSourceSelection(workspaceId, "current"));
  }, [workspaceId]);

  const persistActiveSourceIds = useCallback(
    (sourceIds: string[]) => {
      setActiveSourceIds(sourceIds);
      if (!workspaceId) {
        return;
      }

      writeStoredSourceSelection(workspaceId, "current", sourceIds);
    },
    [workspaceId],
  );

  const handleLibrarySourcesLoad = useCallback(
    (sources: SourceItem[]) => {
      setCachedWorkspaceSources(workspaceId, sources);
      setLibrarySources(sources);
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    if (loadedByokStorageKey !== workspaceId) {
      return;
    }
    writeStoredByokState(
      workspaceId,
      {
        imageByok: selectedByokModels.image ?? null,
        llmByok: selectedByokModels.llm ?? null,
        visionByok: selectedByokModels.vision ?? null,
      },
    );
  }, [loadedByokStorageKey, selectedByokModels, workspaceId]);

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

    writeStoredModelSelection(workspaceId, "current", {
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
  }, [selectedByokModels, selectedModels, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setThinkingSettings(DEFAULT_PROMPT_THINKING_SETTINGS);
      setSearchEnabled(true);
      setLoadedSearchPreferenceKey(null);
      return;
    }

    const searchPreferenceKey = getSearchPreferenceStorageKey(workspaceId);
    const storedThinking = parseStoredThinkingSettings(
      window.sessionStorage.getItem(`chat:thinking:${workspaceId}:current`),
    );
    setHasSavedThinkingPreference(Boolean(storedThinking));
    setThinkingSettings(storedThinking ?? DEFAULT_PROMPT_THINKING_SETTINGS);
    const storedSearch = window.sessionStorage.getItem(searchPreferenceKey);
    setSearchEnabled(storedSearch === null ? true : storedSearch === "true");
    setLoadedSearchPreferenceKey(searchPreferenceKey);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    window.sessionStorage.setItem(
      `chat:thinking:${workspaceId}:current`,
      JSON.stringify(thinkingSettings),
    );
  }, [thinkingSettings, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    const searchPreferenceKey = getSearchPreferenceStorageKey(workspaceId);
    if (loadedSearchPreferenceKey !== searchPreferenceKey) {
      return;
    }
    window.sessionStorage.setItem(
      searchPreferenceKey,
      searchEnabled ? "true" : "false",
    );
  }, [loadedSearchPreferenceKey, searchEnabled, workspaceId]);

  useEffect(() => {
    setThinkingSettings((current) =>
      normalizeThinkingSettingsForModel({
        capabilities: selectedModels.llm?.capabilities,
        hasSavedPreference: hasSavedThinkingPreference,
        settings: current,
      }),
    );
  }, [hasSavedThinkingPreference, selectedModels.llm]);

  const effectiveActiveSkillIds = useMemo(
    () =>
      removeDisabledToolSkills({
        skillIds: activeSkillIds,
        availableSkills,
        disabledToolNames,
      }),
    [activeSkillIds, availableSkills, disabledToolNames],
  );

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
    }
    if (next.sourcesChanged) {
      setModelSelectionSources(next.nextSources);
    }
  }, [
    effectiveActiveSkillIds,
    availableModels,
    availableSkills,
    baseSelectedModels,
    modelSelectionSources,
    selectedByokModels.llm,
    selectedModels,
  ]);

  const handleThinkingSettingsChange = useCallback(
    (settings: PromptThinkingSettings) => {
      setHasSavedThinkingPreference(true);
      setThinkingSettings(settings);
    },
    [],
  );
  const selectedSources = expandSelectedSources(
    librarySources,
    activeSourceIds,
  );

  const handleSendMessage = useCallback(
    async (input: ChatSendInput) => {
      if (!workspaceId) {
        toast.error("No workspace selected yet.");
        return;
      }

      const text = input.content.trim();
      const images = input.images ?? [];
      if (!text && images.length === 0) return;
      const sourceIds = mergeSourceIds(activeSourceIds);
      const mentionedSourceIds = mergeSourceIds(input.mentionedSourceIds);
      const selectedSkillIds = input.skillIds ?? effectiveActiveSkillIds;

      const modelSettings: ModelAliasSettings = {};
      if (catalogKindEnabled.image && selectedModels.image?.profileAlias) {
        modelSettings.imageProfileAlias = selectedModels.image.profileAlias;
      }
      if (catalogKindEnabled.vision && selectedModels.vision?.profileAlias) {
        modelSettings.visionProfileAlias = selectedModels.vision.profileAlias;
      }

      const resolvedThreadModelSettings = buildThreadCreateModelSettings({
        byokSelection: selectedByokModels.llm,
        globalProfileAlias:
          catalogKindEnabled.llm && selectedModels.llm?.profileAlias
            ? selectedModels.llm.profileAlias
            : null,
        imageByokSelection: selectedByokModels.image,
        imageProfileAlias: modelSettings.imageProfileAlias ?? null,
        visionByokSelection: selectedByokModels.vision,
        visionProfileAlias: modelSettings.visionProfileAlias ?? null,
      });
      const thread = await createChat({
        modelSettings: resolvedThreadModelSettings,
      });
      if (!thread) {
        toast.error("Failed to create conversation.");
        return;
      }
      writeStoredByokState(
        workspaceId,
        {
          imageByok: selectedByokModels.image ?? null,
          llmByok: selectedByokModels.llm ?? null,
          visionByok: selectedByokModels.vision ?? null,
        },
        thread.id,
      );

      // Pass the initial message + selected sources to the thread page via
      // session storage (consumed once on mount).
      sessionStorage.setItem(
        `chat:pending:${thread.id}`,
        JSON.stringify({
          content: text,
          images,
          mentionedSourceIds,
          sourceIds,
          skillIds: selectedSkillIds,
          command: input.command,
          tools: buildChatToolsRequest({
            imageExecution:
              selectedByokModels.image?.mode === "byok"
                ? buildByokModelExecution({
                    selection: selectedByokModels.image,
                  })
                : null,
            invokedSkillIds: input.tools?.invokedSkillIds,
            skillIds: selectedSkillIds,
            searchEnabled,
            tools: input.tools,
            forceImageGenerate:
              input.command?.kind === "tool" &&
              input.command.name === `/${AGENT_TOOL_NAMES.generateImage}`,
          }),
          thinking: buildPendingThinking({
            capabilities: selectedModels.llm?.capabilities,
            settings: thinkingSettings,
          }),
          thinkingSettings,
          searchEnabled,
          modelState: {
            availableModels,
            catalogKindEnabled,
            selectedModels,
            byokSelections: selectedByokModels,
          },
        }),
      );

      router.push(`/dashboard/chat/${thread.id}`);
    },
    [
      workspaceId,
      createChat,
      activeSourceIds,
      effectiveActiveSkillIds,
      router,
      catalogKindEnabled,
      availableModels,
      selectedByokModels,
      selectedModels,
      thinkingSettings,
      searchEnabled,
    ],
  );

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-3 px-4 md:px-6 xl:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-semibold text-foreground">
                  New chat
                </h1>
              </div>
              <HeaderModelSelector
                availableModels={availableModels}
                byokCredentials={byokCredentials}
                byokModels={byokModels}
                byokProviders={byokProviders}
                byokSelections={selectedByokModels}
                onAddByokModel={(input) => setByokModelConfig(input)}
                onByokSelect={({ model, selection, type }) => {
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
                  }
                }}
                onModelSelect={(input) => {
                  setModelSelectionSources((current) => ({
                    ...current,
                    [input.type]: "user",
                  }));
                  setSelectedByokModels((current) => ({
                    ...current,
                    [input.type]: null,
                  }));
                  if (input.type === "llm") {
                    setThinkingSettings((current) =>
                      normalizeThinkingSettingsForModel({
                        capabilities: input.model.capabilities,
                        hasSavedPreference: hasSavedThinkingPreference,
                        settings: current,
                      }),
                    );
                  }
                }}
                selectedModels={selectedModels}
                setSelectedModels={setSelectedModels}
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button
                onClick={toggleSourcesVisible}
                size="icon-sm"
                title={sourcesVisible ? "Hide sources" : "Show sources"}
                type="button"
                variant="outline"
              >
                {sourcesVisible ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
                <span className="sr-only">
                  {sourcesVisible ? "Hide sources" : "Show sources"}
                </span>
              </Button>
            </div>
          </div>
        </header>

        <ChatCanvas
          isStreaming={false}
          mode="new"
          availableSkills={availableSkills}
          onArtifactPreview={handleArtifactPreview}
          onRemoveSource={(id) =>
            persistActiveSourceIds(activeSourceIds.filter((x) => x !== id))
          }
          onSkillSelectionChange={setActiveSkillIds}
          onSendMessage={handleSendMessage}
          searchEnabled={searchEnabled}
          onSearchEnabledChange={setSearchEnabled}
          allSources={librarySources}
          sourceMentionLoader={loadSourceMentions}
          selectedSources={selectedSources}
          selectedSkillIds={activeSkillIds}
          sourcesVisible={sourcesVisible}
          thinkingCapabilities={selectedModels.llm?.capabilities}
          imageCapabilities={selectedModels.image?.capabilities?.imageGeneration}
          imageModelAvailable={Boolean(selectedModels.image)}
          imageModelAlias={selectedModels.image?.modelAlias ?? null}
          disabledToolNames={disabledToolNames}
          onDisabledToolNamesChange={setDisabledToolNames}
          thinkingSettings={thinkingSettings}
          onThinkingSettingsChange={handleThinkingSettingsChange}
          threadTitle="New chat"
          workspaceId={workspaceId}
        />
      </div>

      {sourcesVisible && (!previewArtifact || !isDesktopPanel) ? (
          <SourcesHub
            mode="new"
            disabledToolNames={disabledToolNames}
            installedSkills={availableSkills}
            onArtifactOpen={setPreviewArtifact}
            onSkillSelectionChange={setActiveSkillIds}
            onSelectionChange={persistActiveSourceIds}
            onSkillsCatalogChange={loadAvailableSkills}
            initialSources={librarySources}
            initialSourcesLoaded={hasCachedWorkspaceSources(workspaceId)}
            onSourceLoad={handleLibrarySourcesLoad}
            selectedIds={activeSourceIds}
            selectedSkillIds={activeSkillIds}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
          />
        ) : null}

      {sourcesVisible && previewArtifact && isDesktopPanel ? (
        <ArtifactPreviewPanel
          artifact={previewArtifact}
          className="w-[min(640px,45vw)] min-w-[480px] max-w-[720px] shrink-0 animate-in slide-in-from-right-4 duration-200"
          onClose={() => setPreviewArtifact(null)}
          workspaceId={workspaceId}
        />
      ) : null}

      <ByokModelConfigDialog
        defaults={byokModelConfig}
        credentials={byokCredentials}
        onConfigured={({ model, selection, type }) => {
          if (!model || !selection) {
            return;
          }
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
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setByokModelConfig(null);
          }
        }}
        onStateChange={({ credentials, models, providers }) => {
          setByokCredentials(credentials);
          setByokModels(models);
          setByokProviders(providers);
        }}
        open={Boolean(byokModelConfig)}
        providers={byokProviders}
        workspaceId={workspaceId}
      />

      <Sheet
        open={Boolean(sourcesVisible && previewArtifact && !isDesktopPanel)}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewArtifact(null);
          }
        }}
      >
        <SheetContent
          className="h-[90svh] max-h-[90svh] gap-0 overflow-hidden p-0 [&>button]:hidden"
          side="bottom"
        >
          <SheetTitle className="sr-only">
            {previewArtifact ? "Artifact preview" : "Artifact"}
          </SheetTitle>
          {previewArtifact ? (
            <ArtifactPreviewPanel
              artifact={previewArtifact}
              className="border-l-0"
              onClose={() => setPreviewArtifact(null)}
              workspaceId={workspaceId}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
