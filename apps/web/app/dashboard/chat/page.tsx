"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useDashboardChatState } from "../_components/dashboard-chat-state";
import {
  emptyModelCatalog,
  HeaderModelSelector,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  type ModelAliasSettings,
  type ModelItem,
  type SelectedModels,
  type ModelType,
} from "./_components/header-model-selector";
import {
  ChatCanvas,
  DEFAULT_PROMPT_THINKING_SETTINGS,
  type ChatSendInput,
  type ChatSkillItem,
  type PromptInputMentionSourceLoader,
  type PromptThinkingSettings,
} from "./_components/chat-canvas";
import { SourcesHub } from "./_components/sources-hub";
import {
  expandSelectedSources,
  type SourceItem,
} from "./_components/source-types";
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
  const skillsLoadGenerationRef = useRef(0);
  const [selectedModels, setSelectedModels] = useState<SelectedModels>(() =>
    resolveSelectedModels({ availableModels: emptyModelCatalog }),
  );
  const [availableModels, setAvailableModels] =
    useState<Record<ModelType, ModelItem[]>>(emptyModelCatalog);
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
    if (!workspaceId) {
      setAvailableModels(emptyModelCatalog);
      setSelectedModels(
        resolveSelectedModels({ availableModels: emptyModelCatalog }),
      );
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      return;
    }

    const activeWorkspaceId = workspaceId;

    let cancelled = false;

    async function loadModelCatalog() {
      try {
        const catalog =
          await contentClient.listThreadModelCatalog(activeWorkspaceId);
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
        setSelectedModels(
          resolveSelectedModels({
            availableModels: catalogModels,
            fallbackAliases: catalog.defaults,
          }),
        );
      } catch {
        if (cancelled) {
          return;
        }

        setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
        setAvailableModels(emptyModelCatalog);
        setSelectedModels(
          resolveSelectedModels({ availableModels: emptyModelCatalog }),
        );
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

    const raw = window.sessionStorage.getItem(
      `chat:sources:${workspaceId}:current`,
    );
    if (!raw) {
      setActiveSourceIds([]);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      setActiveSourceIds(
        Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === "string")
          : [],
      );
    } catch {
      setActiveSourceIds([]);
    }
  }, [workspaceId]);

  const persistActiveSourceIds = useCallback(
    (sourceIds: string[]) => {
      setActiveSourceIds(sourceIds);
      if (!workspaceId) {
        return;
      }

      window.sessionStorage.setItem(
        `chat:sources:${workspaceId}:current`,
        JSON.stringify(sourceIds),
      );
    },
    [workspaceId],
  );

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
      if (!text) return;
      const sourceIds = mergeSourceIds(activeSourceIds);
      const mentionedSourceIds = mergeSourceIds(input.mentionedSourceIds);

      const modelSettings: ModelAliasSettings = {};
      if (catalogKindEnabled.llm && selectedModels.llm) {
        modelSettings.llmProfileAlias = selectedModels.llm.id;
      }
      if (catalogKindEnabled.image && selectedModels.image) {
        modelSettings.imageProfileAlias = selectedModels.image.id;
      }
      if (catalogKindEnabled.vision && selectedModels.vision) {
        modelSettings.visionProfileAlias = selectedModels.vision.id;
      }

      const hasModelSettings = Object.keys(modelSettings).length > 0;
      const thread = await createChat({
        modelSettings: hasModelSettings ? modelSettings : undefined,
      });
      if (!thread) {
        toast.error("Failed to create conversation.");
        return;
      }

      // Pass the initial message + selected sources to the thread page via
      // session storage (consumed once on mount).
      sessionStorage.setItem(
        `chat:pending:${thread.id}`,
        JSON.stringify({
          content: text,
          mentionedSourceIds,
          sourceIds,
          skillIds: activeSkillIds,
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
          },
        }),
      );

      router.push(`/dashboard/chat/${thread.id}`);
    },
    [
      workspaceId,
      createChat,
      activeSourceIds,
      activeSkillIds,
      router,
      catalogKindEnabled,
      availableModels,
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
                onModelSelect={(input) => {
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
          thinkingSettings={thinkingSettings}
          onThinkingSettingsChange={handleThinkingSettingsChange}
          threadTitle="New chat"
          workspaceId={workspaceId}
        />
      </div>

      {sourcesVisible ? (
        <SourcesHub
          mode="new"
          installedSkills={availableSkills}
          onSkillSelectionChange={setActiveSkillIds}
          onSelectionChange={persistActiveSourceIds}
          onSkillsCatalogChange={loadAvailableSkills}
          onSourceLoad={setLibrarySources}
          selectedIds={activeSourceIds}
          selectedSkillIds={activeSkillIds}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
        />
      ) : null}
    </div>
  );
}
