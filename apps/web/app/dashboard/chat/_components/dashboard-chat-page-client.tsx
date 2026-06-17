"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { SidebarTrigger } from "@sourceweft/ui-web/components/ui/sidebar";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import {
  DASHBOARD_WORKSPACE_SHORTCUT_LIMIT,
  DashboardShortcutsDialog,
  getDashboardWorkspaceShortcutKeys,
  useDashboardShortcuts,
  useDashboardShortcutsOpenListener,
  useDashboardShortcutPlatform,
  type DashboardShortcutDefinition,
} from "../../_components/dashboard-shortcuts";
import {
  emptyModelCatalog,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  resolveSelectedModelsWithByok,
  type ModelItem,
  type SelectedModels,
  type ModelType,
} from "./model-catalog-utils";
import {
  buildThreadCreateModelSettings,
  normalizeByokProviderOptions,
  readStoredByokState,
  writeStoredByokState,
  type ByokCredentialItem,
  type ByokModelSelection,
  type ByokProviderOption,
  type ByokSavedModelItem,
} from "./byok-state";
import type { ByokModelConfigDefaults } from "./byok-model-config-dialog";
import {
  applySkillModelPresetState,
  DEFAULT_MODEL_SELECTION_SOURCES,
  type ModelSelectionSources,
} from "./skill-model-presets";
import {
  EMPTY_ACTIVE_CONNECTOR_TOOLS,
  resolveActiveConnectorToolState,
  type ActiveConnectorToolState,
} from "./connector-agent-tools";
import type { PromptInputMentionSourceLoader } from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import type {
  ArtifactPreviewRecord,
  ChatSendInput,
  ChatSkillItem,
  ChatToolName,
  PromptThinkingSettings,
} from "./chat-canvas/types";
import type {
  ListSkillsCatalogResponse,
  ListThreadModelCatalogResponse,
  ListWorkspaceSkillsResponse,
  ThreadChatPreferences,
} from "@sourceweft/contracts";
import type { RequestThinkingConfig } from "../[threadId]/streaming-request-body";
import type { ArtifactListItem } from "./sources-hub";
import { expandSelectedSources, type SourceItem } from "./source-types";
import {
  readStoredSourceSelection,
  writeStoredSourceSelection,
} from "./source-selection-storage";
import {
  readStoredModelSelection,
  writeStoredModelSelection,
} from "./model-selection-storage";
import {
  setPendingThreadTurn,
  writePendingThreadTurnFallback,
  type PendingThreadTurn,
} from "./pending-thread-turn";
import {
  getCachedWorkspaceSources,
  hasCachedWorkspaceSources,
  setCachedWorkspaceSources,
} from "./source-library-cache";
import {
  desktopBridge,
  handleDesktopAuthDeepLink,
} from "../../../../lib/desktop-bridge";
import { connectorsClient, contentClient } from "../../../../lib/sdk";
import type {
  ListCapabilityCatalogResponse,
  SourceConnector,
} from "@sourceweft/sdk";
import {
  ChatCanvasPanelSkeleton,
  SourcesHubPanelSkeleton,
} from "../../../_components/route-loading-skeleton";
import { resolveChatUiState } from "./chat-ui-state";
import {
  useChatHubContext,
  useRegisterChatHub,
  type ChatHubRegistration,
} from "./chat-hub-context";
import { HUB_STABILITY_PERSISTENT_SHELL_ENABLED } from "./chat-workspace-shell-feature-flag";
import { resolveDefaultActiveSkillIds } from "./chat-canvas/tool-selection";

const EMPTY_MODEL_KIND_FLAGS: Record<ModelType, boolean> = {
  llm: false,
  image: false,
  vision: false,
};
const DEFAULT_THINKING_SETTINGS: PromptThinkingSettings = {
  mode: "auto",
  effort: "medium",
};
type ModelCatalogStatus = "loading" | "ready" | "error";
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
type IdleSchedulerWindow = Window & {
  cancelIdleCallback?: (handle: number) => void;
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions,
  ) => number;
};

const ChatCanvas = dynamic(
  () => import("./chat-canvas/chat-canvas-root").then((mod) => mod.ChatCanvas),
  {
    loading: () => <ChatCanvasSkeleton />,
    ssr: false,
  },
);

const SourcesHub = dynamic(
  () => import("./sources-hub").then((mod) => mod.SourcesHub),
  {
    loading: () => <SourcesHubSkeleton />,
    ssr: false,
  },
);

const ArtifactPreviewPanel = dynamic(
  () => import("./sources-hub").then((mod) => mod.ArtifactPreviewPanel),
  {
    loading: () => <SourcesHubSkeleton />,
    ssr: false,
  },
);

const ByokModelConfigDialog = dynamic(
  () =>
    import("./byok-model-config-dialog").then(
      (mod) => mod.ByokModelConfigDialog,
    ),
  { ssr: false },
);

const HeaderModelSelector = dynamic(
  () =>
    import("./header-model-selector").then((mod) => mod.HeaderModelSelector),
  {
    loading: () => (
      <div className="h-10 w-36 shrink-0 animate-pulse rounded-md bg-muted" />
    ),
    ssr: false,
  },
);

function ChatCanvasSkeleton() {
  return <ChatCanvasPanelSkeleton variant="new" />;
}

function ModelCatalogErrorState() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background px-6 py-10">
      <div className="max-w-sm text-center">
        <h2 className="text-sm font-semibold text-foreground">
          Model catalog failed to load
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Refresh the page before sending a message.
        </p>
      </div>
    </section>
  );
}

function SourcesHubSkeleton() {
  return (
    <SourcesHubPanelSkeleton className="hidden h-full w-[410px] shrink-0 border-l md:flex" />
  );
}

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

function catalogBuiltinSkillToChatSkill(
  skill: ListSkillsCatalogResponse["items"][number],
): ChatSkillItem | null {
  if (
    skill.sourceType !== "builtin" ||
    skill.installable ||
    !skill.selectionId
  ) {
    return null;
  }
  return {
    id: skill.selectionId,
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
    defaultEnabled: skill.defaultEnabled,
    options: skill.options,
  };
}

function workspaceInstalledSkillToChatSkill(
  skill: ListWorkspaceSkillsResponse["items"][number],
): ChatSkillItem | null {
  return {
    id: skill.selectionId,
    workspaceSkillId: skill.workspaceSkillId,
    catalogId: skill.catalogId,
    slug: skill.slug,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    sourceType: skill.sourceType,
    version: skill.version,
    enabled: skill.enabled,
    hasReadme: false,
    capabilities: skill.capabilities,
    models: skill.models,
    tools: skill.tools,
    slash: skill.slash,
    slashConfig: skill.slashConfig,
    commands: skill.commands,
    defaultConfig: skill.defaultConfig,
    options: skill.options,
  };
}

function buildPendingThinking(input: {
  capabilities: ModelItem["capabilities"] | undefined;
  settings: PromptThinkingSettings;
}): RequestThinkingConfig | undefined {
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

function mapChatPreferencesToThinkingSettings(
  preferences: ThreadChatPreferences,
): PromptThinkingSettings {
  return {
    mode: preferences.thinking.mode,
    effort: preferences.thinking.effort,
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

export function DashboardChatPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mcpInstallIdFromQuery = searchParams.get("mcp_install_id");
  const {
    adoptChat,
    bootstrapModelCatalog,
    consumeBootstrapModelCatalog,
    initialChatPreferences,
    sourcesVisible,
    startNewChat,
    switchWorkspace,
    toggleSourcesVisible,
    hasWorkspaceHydrated,
    isWorkspaceHydrating,
    pendingWorkspaceId,
    workspaceId,
    workspaceName,
    workspaceSwitchStatus,
    workspaces,
  } = useDashboardChatState();
  const chatHubContext = useChatHubContext();

  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<ChatSkillItem[]>([]);
  const [hubSkills, setHubSkills] = useState<ChatSkillItem[]>([]);
  const [capabilityCatalog, setCapabilityCatalog] =
    useState<ListCapabilityCatalogResponse | null>(null);
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const [activeMcpInstallIds, setActiveMcpInstallIds] = useState<string[]>([]);
  const [activeMcpToolIds, setActiveMcpToolIds] = useState<string[]>([]);
  const [disabledToolNames, setDisabledToolNames] = useState<ChatToolName[]>(
    [],
  );
  const [activeConnectorTools, setActiveConnectorTools] =
    useState<ActiveConnectorToolState>(EMPTY_ACTIVE_CONNECTOR_TOOLS);
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [composerRecoveryInput, setComposerRecoveryInput] = useState("");
  const [composerRecoveryKey, setComposerRecoveryKey] = useState(0);
  const [previewArtifact, setPreviewArtifact] =
    useState<ArtifactListItem | null>(null);
  const isPersistentLayout = useMediaQuery("(min-width: 768px)");
  const isDesktopPanel = useMediaQuery("(min-width: 1024px)");
  const isStartingChatRef = useRef(false);
  const appliedMcpRunRef = useRef<string | null>(null);
  const handledConnectorOAuthHubRef = useRef(false);
  const skillsLoadGenerationRef = useRef(0);
  const capabilityCatalogLoadGenerationRef = useRef(0);
  const initialSourcesForWorkspace = useMemo(
    () => getCachedWorkspaceSources(workspaceId) ?? librarySources,
    [librarySources, workspaceId],
  );
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
  const [thinkingSettings, setThinkingSettings] =
    useState<PromptThinkingSettings>(DEFAULT_THINKING_SETTINGS);
  const [hasSavedThinkingPreference, setHasSavedThinkingPreference] =
    useState(false);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useDashboardShortcutsOpenListener(() => setShortcutsOpen(true));
  const [hubDrawerOpen, setHubDrawerOpen] = useState(false);
  const shortcutPlatform = useDashboardShortcutPlatform();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (handledConnectorOAuthHubRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("connector_oauth");
    if (oauthStatus === "success" || oauthStatus === "error") {
      handledConnectorOAuthHubRef.current = true;
      if (window.matchMedia("(min-width: 768px)").matches) {
        if (!sourcesVisible) {
          toggleSourcesVisible();
        }
        return;
      }
      if (HUB_STABILITY_PERSISTENT_SHELL_ENABLED) {
        chatHubContext?.setMobileHubOpen(true);
        return;
      }
      setHubDrawerOpen(true);
    }
  }, [chatHubContext, sourcesVisible, toggleSourcesVisible]);

  const handleArtifactPreview = useCallback(
    (artifact: ArtifactPreviewRecord) => {
      setPreviewArtifact(artifact);
      if (!sourcesVisible) {
        toggleSourcesVisible();
      }
    },
    [sourcesVisible, toggleSourcesVisible],
  );
  const handleConnectorsChange = useCallback(
    (connectors: SourceConnector[]) => {
      setActiveConnectorTools(resolveActiveConnectorToolState(connectors));
    },
    [],
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
    const preloadThreadRoute = () => {
      void import("../[threadId]/_thread/dashboard-chat-thread-page-root");
    };
    const idleWindow = window as IdleSchedulerWindow;

    const scheduler =
      typeof idleWindow.requestIdleCallback === "function"
        ? {
            kind: "idle" as const,
            value: idleWindow.requestIdleCallback(preloadThreadRoute, {
              timeout: 1500,
            }),
          }
        : {
            kind: "timeout" as const,
            value: window.setTimeout(preloadThreadRoute, 250),
          };

    return () => {
      if (scheduler.kind === "idle") {
        idleWindow.cancelIdleCallback?.(scheduler.value);
        return;
      }
      window.clearTimeout(scheduler.value);
    };
  }, []);

  useEffect(() => {
    setLibrarySources(getCachedWorkspaceSources(workspaceId) ?? []);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setActiveConnectorTools(EMPTY_ACTIVE_CONNECTOR_TOOLS);
      return;
    }

    let cancelled = false;
    void connectorsClient
      .list(workspaceId)
      .then((result) => {
        if (!cancelled) {
          setActiveConnectorTools(
            resolveActiveConnectorToolState(result.items),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActiveConnectorTools(EMPTY_ACTIVE_CONNECTOR_TOOLS);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setLoadedByokStorageKey(null);
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
    setModelCatalogStatus("loading");

    function applyModelCatalog(catalog: ListThreadModelCatalogResponse) {
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
      setModelCatalogStatus("ready");
    }

    async function loadModelCatalog() {
      try {
        const initialCatalog = consumeBootstrapModelCatalog(activeWorkspaceId);
        if (initialCatalog) {
          applyModelCatalog(initialCatalog);
        }

        const [catalogResult, providerResult, credentialResult, modelResult] =
          await Promise.all([
            initialCatalog
              ? Promise.resolve<ListThreadModelCatalogResponse | null>(null)
              : contentClient.listThreadModelCatalog(activeWorkspaceId),
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

        if (catalogResult) {
          applyModelCatalog(catalogResult);
        }
        setByokCredentials(credentialResult.items);
        setByokModels(modelResult.items);
        setByokProviders(
          normalizeByokProviderOptions(providerResult, credentialResult.items),
        );
      } catch {
        if (cancelled) {
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
      }
    }

    void loadModelCatalog();

    return () => {
      cancelled = true;
    };
  }, [bootstrapModelCatalog, consumeBootstrapModelCatalog, workspaceId]);

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
      setHubSkills([]);
      setActiveSkillIds([]);
      return;
    }

    const activeWorkspaceId = workspaceId;
    try {
      const [installedResult, catalogResult] = await Promise.all([
        contentClient.listWorkspaceSkills(activeWorkspaceId),
        contentClient.listSkillsCatalog(activeWorkspaceId),
      ]);
      if (
        skillsLoadGenerationRef.current !== loadGeneration ||
        activeWorkspaceId !== workspaceId
      ) {
        return;
      }
      const builtinOptionSkills = catalogResult.items
        .map(catalogBuiltinSkillToChatSkill)
        .filter((skill): skill is ChatSkillItem => Boolean(skill));
      const workspaceInstalledSkills = installedResult.items
        .map(workspaceInstalledSkillToChatSkill)
        .filter((skill): skill is ChatSkillItem => Boolean(skill));
      const enabledWorkspaceSkills = workspaceInstalledSkills.filter(
        (skill) => skill.enabled,
      );
      const enabledSkills = [...builtinOptionSkills, ...enabledWorkspaceSkills];
      setAvailableSkills(enabledSkills);
      setHubSkills([...builtinOptionSkills, ...workspaceInstalledSkills]);

      const optionControlledIds = new Set(
        builtinOptionSkills.map((skill) => skill.id),
      );
      setActiveSkillIds((current) =>
        resolveDefaultActiveSkillIds({
          availableSkills: builtinOptionSkills,
          currentSkillIds: current.filter((id) => optionControlledIds.has(id)),
        }),
      );
    } catch {
      if (skillsLoadGenerationRef.current !== loadGeneration) {
        return;
      }
      setAvailableSkills([]);
      setHubSkills([]);
      setActiveSkillIds([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadAvailableSkills();
  }, [loadAvailableSkills]);

  useEffect(() => {
    const loadGeneration = ++capabilityCatalogLoadGenerationRef.current;
    if (!workspaceId) {
      setCapabilityCatalog(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    void contentClient
      .listCapabilityCatalog(activeWorkspaceId)
      .then((result) => {
        if (
          capabilityCatalogLoadGenerationRef.current !== loadGeneration ||
          activeWorkspaceId !== workspaceId
        ) {
          return;
        }
        setCapabilityCatalog(result);
      })
      .catch(() => {
        if (capabilityCatalogLoadGenerationRef.current !== loadGeneration) {
          return;
        }
        setCapabilityCatalog({ commands: [], tools: [] });
      });
  }, [workspaceId]);

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
  const handleLibrarySourcesMerge = useCallback((sources: SourceItem[]) => {
    setLibrarySources((current) => {
      const mergedById = new Map(current.map((source) => [source.id, source]));
      for (const source of sources) {
        mergedById.set(source.id, source);
      }
      return Array.from(mergedById.values());
    });
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    if (loadedByokStorageKey !== workspaceId) {
      return;
    }
    writeStoredByokState(workspaceId, {
      imageByok: selectedByokModels.image ?? null,
      llmByok: selectedByokModels.llm ?? null,
      visionByok: selectedByokModels.vision ?? null,
    });
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
          : (selectedModels.llm?.profileAlias ??
            selectedModels.llm?.id ??
            null),
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
      setThinkingSettings(DEFAULT_THINKING_SETTINGS);
      setSearchEnabled(true);
      return;
    }

    setHasSavedThinkingPreference(
      initialChatPreferences.thinking.mode === "off" ||
        initialChatPreferences.thinking.mode === "effort",
    );
    setThinkingSettings(
      mapChatPreferencesToThinkingSettings(initialChatPreferences),
    );
    setSearchEnabled(initialChatPreferences.webAccess);
  }, [initialChatPreferences, workspaceId]);

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

  const handleWorkspaceShortcut = useCallback(
    (targetWorkspaceId: string) => {
      if (targetWorkspaceId === workspaceId) {
        return;
      }

      void switchWorkspace(targetWorkspaceId).then((switched) => {
        if (switched) {
          router.push("/dashboard/chat");
        }
      });
    },
    [router, switchWorkspace, workspaceId],
  );

  const shortcutDefinitions = useMemo<DashboardShortcutDefinition[]>(
    () =>
      workspaces
        .slice(0, DASHBOARD_WORKSPACE_SHORTCUT_LIMIT)
        .map((workspace, index) => ({
          group: "Workspace",
          id: `workspace-${workspace.id}`,
          keys: getDashboardWorkspaceShortcutKeys(index, shortcutPlatform),
          onRun: () => handleWorkspaceShortcut(workspace.id),
          title: `Switch to ${workspace.name}`,
        })),
    [handleWorkspaceShortcut, shortcutPlatform, workspaces],
  );

  useDashboardShortcuts(shortcutDefinitions);

  const selectedSources = expandSelectedSources(
    librarySources,
    activeSourceIds,
  );
  const chatUiState = useMemo(
    () =>
      resolveChatUiState({
        routeKind: "new",
        shellStatus:
          isWorkspaceHydrating && !hasWorkspaceHydrated ? "loading" : "ready",
        workspaceStatus:
          (isWorkspaceHydrating && !hasWorkspaceHydrated) || pendingWorkspaceId
            ? "loading"
            : "ready",
        modelCatalogStatus,
        sourcesStatus: "ready",
        creationStatus: isStartingChat ? "loading" : "idle",
        hasMessages: false,
        isWorkspaceShortcutPending: workspaceSwitchStatus === "loading",
      }),
    [
      hasWorkspaceHydrated,
      isStartingChat,
      isWorkspaceHydrating,
      modelCatalogStatus,
      pendingWorkspaceId,
      workspaceSwitchStatus,
    ],
  );
  const isCreatingFirstThread =
    chatUiState.status === "creating-thread" &&
    chatUiState.skeletonPolicy === "inline";
  const shouldShowModelCatalogError =
    chatUiState.status === "model-error" &&
    chatUiState.errorKind === "model-catalog";
  const handleMcpSelectionChange = useCallback(
    (selection: { installIds?: string[]; toolIds?: string[] }) => {
      setActiveMcpInstallIds(selection.installIds ?? []);
      setActiveMcpToolIds(selection.toolIds ?? []);
    },
    [],
  );
  const chatHubRegistration = useMemo<ChatHubRegistration>(
    () => ({
      activeCitationIndex: null,
      activeCitationMessageId: null,
      activeMcpInstallIds,
      activeMcpToolIds,
      activeSkillIds,
      activeSourceIds,
      artifactsRefreshKey: 0,
      availableSkills,
      hubSkills,
      capabilityCatalog,
      disabledToolNames,
      displayedCitations: [],
      initialSources: initialSourcesForWorkspace,
      initialSourcesLoaded: hasCachedWorkspaceSources(workspaceId),
      mode: "new",
      onArtifactOpen: setPreviewArtifact,
      onArtifactPreviewClose: () => setPreviewArtifact(null),
      onMcpSelectionChange: handleMcpSelectionChange,
      onSelectionChange: persistActiveSourceIds,
      onSkillSelectionChange: setActiveSkillIds,
      onSkillsCatalogChange: loadAvailableSkills,
      onSourceLoad: handleLibrarySourcesLoad,
      onSourceMerge: handleLibrarySourcesMerge,
      onConnectorsChange: handleConnectorsChange,
      previewArtifact,
      threadCitations: [],
      threadId: null,
      workfilesRefreshKey: 0,
      workspaceId,
      workspaceName,
    }),
    [
      activeMcpInstallIds,
      activeMcpToolIds,
      activeSkillIds,
      activeSourceIds,
      availableSkills,
      hubSkills,
      capabilityCatalog,
      disabledToolNames,
      handleConnectorsChange,
      handleLibrarySourcesLoad,
      handleLibrarySourcesMerge,
      handleMcpSelectionChange,
      initialSourcesForWorkspace,
      loadAvailableSkills,
      persistActiveSourceIds,
      previewArtifact,
      workspaceId,
      workspaceName,
    ],
  );
  useRegisterChatHub(
    chatHubRegistration,
    HUB_STABILITY_PERSISTENT_SHELL_ENABLED,
  );

  useEffect(() => {
    if (!workspaceId || !mcpInstallIdFromQuery) {
      return;
    }
    const runKey = `${workspaceId}:${mcpInstallIdFromQuery}`;
    if (appliedMcpRunRef.current === runKey) {
      return;
    }
    appliedMcpRunRef.current = runKey;
    setActiveMcpInstallIds([mcpInstallIdFromQuery]);
    setActiveMcpToolIds([]);
    toast.success("MCP selected for this chat");

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("mcp_install_id");
    const nextQuery = nextParams.toString();
    router.replace(
      nextQuery ? `/dashboard/chat?${nextQuery}` : "/dashboard/chat",
    );
  }, [mcpInstallIdFromQuery, router, searchParams, workspaceId]);

  const handleSendMessage = useCallback(
    async (input: ChatSendInput) => {
      if (isStartingChatRef.current) {
        return;
      }
      if (!workspaceId) {
        toast.error("No workspace selected yet.");
        return;
      }
      if (modelCatalogStatus !== "ready") {
        toast.error(
          modelCatalogStatus === "error"
            ? "Model catalog failed to load. Refresh and try again."
            : "Model catalog is still loading. Try again in a moment.",
        );
        return;
      }
      if (!selectedModels.llm?.capabilities) {
        toast.error("Chat model capabilities are not loaded yet.");
        return;
      }

      const text = input.content.trim();
      const images = input.images ?? [];
      if (!text && images.length === 0) return;
      const sourceIds = mergeSourceIds(activeSourceIds);
      const mentionedSourceIds = mergeSourceIds(input.mentionedSourceIds);
      const selectedSkillIds = input.skillIds ?? effectiveActiveSkillIds;
      const selectedMcp =
        input.tools?.mcp ??
        (activeMcpInstallIds.length > 0 || activeMcpToolIds.length > 0
          ? {
              enabled: true,
              installIds: activeMcpInstallIds,
              toolIds: activeMcpToolIds,
            }
          : undefined);
      const tools = selectedMcp
        ? { ...(input.tools ?? {}), mcp: selectedMcp }
        : input.tools;

      const resolvedThreadModelSettings = buildThreadCreateModelSettings({
        byokSelection: selectedByokModels.llm,
        globalProfileAlias:
          catalogKindEnabled.llm && selectedModels.llm?.profileAlias
            ? selectedModels.llm.profileAlias
            : null,
        imageByokSelection: selectedByokModels.image,
        imageProfileAlias:
          catalogKindEnabled.image && selectedModels.image?.profileAlias
            ? selectedModels.image.profileAlias
            : null,
        visionByokSelection: selectedByokModels.vision,
        visionProfileAlias:
          catalogKindEnabled.vision && selectedModels.vision?.profileAlias
            ? selectedModels.vision.profileAlias
            : null,
      });
      const thinking = buildPendingThinking({
        capabilities: selectedModels.llm?.capabilities,
        settings: thinkingSettings,
      });

      isStartingChatRef.current = true;
      setIsStartingChat(true);
      setComposerRecoveryInput("");
      try {
        const result = await contentClient.createThread(workspaceId, {
          title: "New chat",
          modelSettings: resolvedThreadModelSettings,
          chatPreferences: {
            thinking: thinkingSettings,
            webAccess: searchEnabled,
            composerOptions: {},
          },
        });
        adoptChat(result.thread);
        writeStoredSourceSelection(workspaceId, result.thread.id, sourceIds);
        writeStoredByokState(
          workspaceId,
          {
            imageByok: selectedByokModels.image ?? null,
            llmByok: selectedByokModels.llm ?? null,
            visionByok: selectedByokModels.vision ?? null,
          },
          result.thread.id,
        );
        const pendingTurn: PendingThreadTurn = {
          content: text,
          images,
          mentionedSourceIds,
          sourceIds,
          skillIds: selectedSkillIds,
          tools,
          command: input.command,
          invocation: input.invocation,
          thinking,
          thinkingSettings,
          searchEnabled,
          modelState: {
            availableModels,
            catalogKindEnabled,
            catalogReady: true,
            selectedModels,
            byokSelections: selectedByokModels,
          },
        };
        setPendingThreadTurn(result.thread.id, pendingTurn);
        writePendingThreadTurnFallback(result.thread.id, pendingTurn);
        router.prefetch(`/dashboard/chat/${result.thread.id}`);
        router.push(`/dashboard/chat/${result.thread.id}`);
      } catch (error) {
        console.error(error);
        toast.error("Failed to create conversation.");
        isStartingChatRef.current = false;
        setIsStartingChat(false);
        setComposerRecoveryInput(input.content);
        setComposerRecoveryKey((value) => value + 1);
      } finally {
        if (!isStartingChatRef.current) {
          setIsStartingChat(false);
        }
      }
    },
    [
      workspaceId,
      adoptChat,
      activeSourceIds,
      availableModels,
      effectiveActiveSkillIds,
      activeMcpInstallIds,
      activeMcpToolIds,
      router,
      catalogKindEnabled,
      modelCatalogStatus,
      selectedByokModels,
      selectedModels,
      thinkingSettings,
      searchEnabled,
    ],
  );

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
          <div className="flex min-h-16 flex-wrap items-start justify-between gap-2 px-3 py-2 md:h-16 md:flex-nowrap md:items-center md:gap-3 md:px-6 md:py-0 xl:px-8">
            <div className="flex min-w-0 flex-1 self-stretch items-center gap-2 overflow-hidden md:gap-2.5">
              <div className="shrink-0 md:hidden">
                <SidebarTrigger />
              </div>
              <div className="flex min-w-0 flex-1 items-center md:flex-none">
                <h1 className="truncate text-base leading-none font-semibold text-foreground">
                  New chat
                </h1>
              </div>
            </div>

            <div className="contents md:ml-auto md:flex md:h-10 md:shrink-0 md:items-center md:gap-2">
              <HeaderModelSelector
                availableModels={availableModels}
                byokCredentials={byokCredentials}
                byokModels={byokModels}
                byokProviders={byokProviders}
                byokSelections={selectedByokModels}
                isLoading={modelCatalogStatus === "loading"}
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
              <Button
                className="size-8 md:h-10 md:w-10 md:border-border/60 md:bg-background md:shadow-xs"
                onClick={() => {
                  if (isPersistentLayout) {
                    toggleSourcesVisible();
                    return;
                  }
                  if (HUB_STABILITY_PERSISTENT_SHELL_ENABLED) {
                    chatHubContext?.setMobileHubOpen(true);
                    return;
                  }
                  setHubDrawerOpen(true);
                }}
                size="icon-sm"
                title={
                  isPersistentLayout
                    ? sourcesVisible
                      ? "Hide sources"
                      : "Show sources"
                    : "Open Hub"
                }
                type="button"
                variant="outline"
              >
                {isPersistentLayout && sourcesVisible ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
                <span className="sr-only">
                  {isPersistentLayout
                    ? sourcesVisible
                      ? "Hide sources"
                      : "Show sources"
                    : "Open Hub"}
                </span>
              </Button>
            </div>
          </div>
        </header>

        {shouldShowModelCatalogError ? (
          <ModelCatalogErrorState />
        ) : (
          <ChatCanvas
            isStreaming={isCreatingFirstThread}
            mode="new"
            availableSkills={availableSkills}
            capabilityCatalog={capabilityCatalog}
            composerInitialInput={composerRecoveryInput}
            composerResetKey={composerRecoveryKey}
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
            selectedMcpInstallIds={activeMcpInstallIds}
            selectedMcpToolIds={activeMcpToolIds}
            sourcesVisible={sourcesVisible}
            thinkingCapabilities={selectedModels.llm?.capabilities}
            imageCapabilities={
              selectedModels.image?.capabilities?.imageGeneration
            }
            imageModelAvailable={Boolean(selectedModels.image)}
            imageModelAlias={selectedModels.image?.modelAlias ?? null}
            notionConnectorId={activeConnectorTools.notionConnectorId}
            activeConnectorIds={activeConnectorTools.activeConnectorIds}
            disabledToolNames={disabledToolNames}
            onDisabledToolNamesChange={setDisabledToolNames}
            thinkingSettings={thinkingSettings}
            onThinkingSettingsChange={handleThinkingSettingsChange}
            threadTitle="New chat"
            workspaceId={workspaceId}
          />
        )}
      </div>

      {sourcesVisible &&
      isPersistentLayout &&
      !previewArtifact &&
      !HUB_STABILITY_PERSISTENT_SHELL_ENABLED ? (
        <SourcesHub
          mode="new"
          capabilityCatalog={capabilityCatalog}
          disabledToolNames={disabledToolNames}
          installedSkills={availableSkills}
          hubSkills={hubSkills}
          selectedMcpInstallIds={activeMcpInstallIds}
          selectedMcpToolIds={activeMcpToolIds}
          onMcpSelectionChange={handleMcpSelectionChange}
          onArtifactOpen={setPreviewArtifact}
          onSkillSelectionChange={setActiveSkillIds}
          onSelectionChange={persistActiveSourceIds}
          onSkillsCatalogChange={loadAvailableSkills}
          initialSources={initialSourcesForWorkspace}
          initialSourcesLoaded={hasCachedWorkspaceSources(workspaceId)}
          onSourceLoad={handleLibrarySourcesLoad}
          onSourceMerge={handleLibrarySourcesMerge}
          onConnectorsChange={handleConnectorsChange}
          selectedIds={activeSourceIds}
          selectedSkillIds={activeSkillIds}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
        />
      ) : null}

      {sourcesVisible &&
      previewArtifact &&
      isDesktopPanel &&
      !HUB_STABILITY_PERSISTENT_SHELL_ENABLED ? (
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

      <DashboardShortcutsDialog
        definitions={shortcutDefinitions}
        onOpenChange={setShortcutsOpen}
        open={shortcutsOpen}
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

      <Sheet
        open={HUB_STABILITY_PERSISTENT_SHELL_ENABLED ? false : hubDrawerOpen}
        onOpenChange={setHubDrawerOpen}
      >
        <SheetContent
          className="w-[calc(100vw-1rem)] max-w-[360px] gap-0 overflow-hidden p-0 sm:w-[380px] sm:max-w-[380px] [&>button]:hidden"
          side="right"
        >
          <SheetTitle className="sr-only">Hub</SheetTitle>
          <SourcesHub
            mode="new"
            capabilityCatalog={capabilityCatalog}
            onClose={() => setHubDrawerOpen(false)}
            disabledToolNames={disabledToolNames}
            installedSkills={availableSkills}
            hubSkills={hubSkills}
            selectedMcpInstallIds={activeMcpInstallIds}
            selectedMcpToolIds={activeMcpToolIds}
            onMcpSelectionChange={handleMcpSelectionChange}
            onArtifactOpen={(artifact) => {
              setPreviewArtifact(artifact);
              setHubDrawerOpen(false);
            }}
            onSkillSelectionChange={setActiveSkillIds}
            onSelectionChange={persistActiveSourceIds}
            onSkillsCatalogChange={loadAvailableSkills}
            initialSources={initialSourcesForWorkspace}
            initialSourcesLoaded={hasCachedWorkspaceSources(workspaceId)}
            onSourceLoad={handleLibrarySourcesLoad}
            onSourceMerge={handleLibrarySourcesMerge}
            onConnectorsChange={handleConnectorsChange}
            selectedIds={activeSourceIds}
            selectedSkillIds={activeSkillIds}
            variant="drawer"
            workspaceId={workspaceId}
            workspaceName={workspaceName}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
