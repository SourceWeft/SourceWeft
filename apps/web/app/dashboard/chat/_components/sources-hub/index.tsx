"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  Loader2,
  RotateCcw,
  Search,
  SquareCheckBig,
  SquareMinus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  type ListCapabilityCatalogResponse,
  type McpToolSelection,
  type SourceConnector,
} from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient } from "../../../../../lib/sdk";
import { McpIcon, SkillIcon } from "../../../_components/dashboard-icons";
import { SkillsGallery } from "../../../skills/_components/skills-gallery";
import type { CitationRecord } from "../chat-canvas";
import { SourcePreviewPanel } from "../source-preview-panel";
import { type SourceItem } from "../source-types";
import { artifactMatchesQuery } from "./artifacts";
import { ManageConnectorsDialog } from "./connectors/manage-dialog";
import { ConnectorSettingsDialog } from "./connectors/settings-dialog";
import { ConnectorsTab } from "./connectors/tab";
import { ConnectorDisconnectDialog } from "./connectors/disconnect-dialog";
import {
  useConnectors,
  type TrackConnectorSyncRun,
} from "./connectors/use-connectors";
import { createHubTabStorage } from "./storage";
import { CitationsTab } from "./citations/tab";
import { SkillReadmeDialog } from "./skills/readme-dialog";
import {
  useCitations,
  type CitationOpenContext,
  type ThreadCitationRecord,
} from "./citations/use-citations";
import { SkillsTab } from "./skills/tab";
import {
  buildHubSkillIconsById,
  countFilteredSkills,
  type HubSkillItem,
} from "./skills/use-skills";
import { ArtifactsTab } from "./artifacts/tab";
import { loadArtifactDetail } from "./artifacts/artifact-detail-loader";
import { useArtifacts } from "./artifacts/use-artifacts";
import { McpTab } from "./mcp/tab";
import { useMcp } from "./mcp/use-mcp";
import { McpMarket } from "../../../mcp/_components/mcp-market";
import { sourceMatchesQuery } from "./sources/components";
import {
  AddSourceDialog,
  CreateDirectoryDialog,
  DeleteSelectedSourcesDialog,
  DeleteSourceDialog,
  MoveSourceDialog,
  ReadmeDialog,
} from "./sources/dialogs";
import { SourcesTab } from "./sources/tab";
import { useAddSourceDialogState } from "./sources/use-add-source-dialog";
import { useSources } from "./sources/use-sources";
import {
  DeleteWorkfileDialog,
  WorkfilePreviewDialog,
} from "./workfiles/dialogs";
import { WorkfilesTab } from "./workfiles/tab";
import { useWorkfiles, workfileMatchesQuery } from "./workfiles/use-workfiles";
import type { ArtifactListItem, ArtifactSummaryItem } from "./types";
import { useConnectorSyncRuns } from "./use-connector-sync-runs";
import { getErrorMessage } from "./lib/errors";

export { ArtifactPreviewPanel } from "../artifact-preview/artifact-preview-panel";
export type { ArtifactListItem, ArtifactSummaryItem } from "./types";
export type { ThreadCitationRecord } from "./citations/use-citations";
export type { HubSkillItem } from "./skills/use-skills";

const tabs = [
  "Sources",
  "Workfiles",
  "Artifacts",
  "Connectors",
  "Skills",
  "MCP",
] as const;
const HUB_ACTIVE_TAB_STORAGE_KEY = "chat:sources-hub:active-tab:v1";
const ACTIVE_SYNC_RUN_TABS = new Set<HubTab>(["Sources", "Connectors"]);

type HubTab = (typeof tabs)[number] | "Citations";
const hubTabStorage = createHubTabStorage<HubTab>({
  allowedTabs: [...tabs, "Citations"],
  defaultTab: "Sources",
  storageKey: HUB_ACTIVE_TAB_STORAGE_KEY,
});

const readStoredHubTab = hubTabStorage.readStoredHubTab;
const persistHubTab = hubTabStorage.persistHubTab;
const getLastHubActiveTab = hubTabStorage.getLastHubActiveTab;

const searchPlaceholders: Record<HubTab, string> = {
  Sources: "Search sources...",
  Workfiles: "Search workfiles...",
  Artifacts: "Search artifacts...",
  Skills: "Search installed skills...",
  MCP: "Search MCP tools...",
  Citations: "Search citations...",
  Connectors: "Search connectors...",
};

const searchScopeLabels: Record<HubTab, string> = {
  Sources: "Sources",
  Workfiles: "Workfiles",
  Artifacts: "Artifacts",
  Skills: "Skills",
  MCP: "MCP",
  Citations: "Citations",
  Connectors: "Connectors",
};

function shouldPollConnectorSyncRuns(tab: HubTab) {
  return ACTIVE_SYNC_RUN_TABS.has(tab);
}

function countFilteredSources(items: SourceItem[], searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    return items.length;
  }
  return items.filter((source) => sourceMatchesQuery(source, q)).length;
}

export function SourcesHub({
  activeCitationIndex = null,
  citations = [],
  currentCitationMessageId = null,
  mode,
  onCitationOpen,
  onCitationLocate,
  selectedIds,
  onSelectionChange,
  threadCitations = [],
  threadId = null,
  artifactsRefreshKey = 0,
  workfilesRefreshKey = 0,
  workspaceId,
  workspaceName,
  initialSources = [],
  initialSourcesLoaded = false,
  onSourceLoad,
  onSourceMerge,
  onConnectorsChange,
  onArtifactOpen,
  onSkillsCatalogChange,
  installedSkills = [],
  hubSkills,
  capabilityCatalog,
  selectedSkillIds = [],
  onSkillSelectionChange = () => {},
  selectedMcpInstallIds = [],
  selectedMcpToolIds = [],
  onMcpSelectionChange = () => {},
  disabledToolNames = [],
  onClose,
  variant = "panel",
}: {
  activeCitationIndex?: number | null;
  citations?: CitationRecord[];
  currentCitationMessageId?: string | null;
  mode: "thread" | "new";
  onCitationOpen?: (
    citation: CitationRecord,
    context?: CitationOpenContext,
  ) => void;
  onCitationLocate?: (messageId: string) => void;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  threadCitations?: ThreadCitationRecord[];
  threadId?: string | null;
  artifactsRefreshKey?: number;
  workfilesRefreshKey?: number;
  workspaceId?: string | null;
  workspaceName?: string | null;
  initialSources?: SourceItem[];
  initialSourcesLoaded?: boolean;
  onSourceLoad?: (sources: SourceItem[]) => void;
  onSourceMerge?: (sources: SourceItem[]) => void;
  onConnectorsChange?: (connectors: SourceConnector[]) => void;
  onArtifactOpen?: (artifact: ArtifactListItem) => void;
  onSkillsCatalogChange?: () => void | Promise<void>;
  installedSkills?: HubSkillItem[];
  hubSkills?: HubSkillItem[];
  capabilityCatalog?: ListCapabilityCatalogResponse | null;
  selectedSkillIds?: string[];
  onSkillSelectionChange?: (ids: string[]) => void;
  selectedMcpInstallIds?: string[];
  selectedMcpToolIds?: string[];
  onMcpSelectionChange?: (selection: McpToolSelection) => void;
  disabledToolNames?: string[];
  onClose?: () => void;
  variant?: "panel" | "drawer";
}) {
  const [activeTab, setActiveTab] = useState<HubTab>(getLastHubActiveTab);
  const [searchQueries, setSearchQueries] = useState<Record<HubTab, string>>({
    Sources: "",
    Workfiles: "",
    Artifacts: "",
    Skills: "",
    MCP: "",
    Citations: "",
    Connectors: "",
  });
  const searchQuery = searchQueries[activeTab];
  const deferredSearchQueries = useDeferredValue(searchQueries);
  const deferredSearchQuery = deferredSearchQueries[activeTab];
  const skillsForHub = hubSkills ?? installedSkills;
  const currentWorkspaceIdRef = useRef<string | null | undefined>(workspaceId);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const [tabScrollState, setTabScrollState] = useState({
    canScrollLeft: false,
    canScrollRight: false,
  });
  const [previewSkillCatalogId, setPreviewSkillCatalogId] = useState<
    string | null
  >(null);
  const [isSkillsGalleryOpen, setIsSkillsGalleryOpen] = useState(false);
  const [isMcpMarketOpen, setIsMcpMarketOpen] = useState(false);
  const [openingArtifactId, setOpeningArtifactId] = useState<string | null>(
    null,
  );
  const artifactOpenGenerationRef = useRef(0);
  const {
    workfiles,
    isLoadingWorkfiles,
    workfilesLoadingError,
    previewWorkfile,
    setPreviewWorkfile,
    deleteWorkfile,
    setDeleteWorkfile,
    workfileBusyByPath,
    refreshWorkfiles,
    handleOpenWorkfile,
    handleConfirmDeleteWorkfile,
  } = useWorkfiles({
    mode,
    workspaceId,
    threadId,
    workfilesRefreshKey,
    currentWorkspaceIdRef,
  });
  const {
    artifacts,
    isLoadingArtifacts,
    isLoadingMoreArtifacts,
    artifactsLoadingError,
    artifactsNextCursor,
    refreshArtifacts,
    loadMoreArtifacts,
  } = useArtifacts({
    workspaceId,
    artifactsRefreshKey,
    currentWorkspaceIdRef,
    enabled: activeTab === "Artifacts",
  });
  const { mcpInstalls, isLoadingMcp, mcpLoadingError, refreshMcpInstalls } =
    useMcp({
      workspaceId,
      selectedMcpInstallIds,
      selectedMcpToolIds,
      onMcpSelectionChange,
      currentWorkspaceIdRef,
    });
  const trackConnectorSyncRunRef = useRef<TrackConnectorSyncRun | null>(null);
  const stableTrackConnectorSyncRun = useCallback<TrackConnectorSyncRun>(
    (run) => trackConnectorSyncRunRef.current?.(run),
    [],
  );
  const refreshSourcesRef = useRef<() => void | Promise<void>>(() => {});
  const refreshSourcesForConnectors = useCallback(
    () => refreshSourcesRef.current(),
    [],
  );
  const manualConnectorSyncSourcesRef = useRef<
    Map<string, { knownSourceIds: Set<string> }>
  >(new Map());
  const addSourceDialog = useAddSourceDialogState();
  const {
    sources,
    refreshSources,
    mergeIncrementalSources,
    replaceConnectorSources,
    sourceTreeIndex,
    selectableSourceIds,
    allSelectableSourcesSelected,
    selectedSourceIdsForBulkDelete,
    selectedSourceCoverageCount,
    isLoading,
    loadingError,
    pendingSourceIds,
    expandedDirectoryIds,
    userCollapsedDirectoryIds,
    editingSourceId,
    editingTitle,
    setEditingTitle,
    rowBusyById,
    previewSource,
    setPreviewSource,
    deleteSource,
    setDeleteSource,
    deleteSelectedSourcesOpen,
    setDeleteSelectedSourcesOpen,
    isDeletingSelectedSources,
    isCreateDirectoryOpen,
    setIsCreateDirectoryOpen,
    directoryTitle,
    setDirectoryTitle,
    directoryContext,
    setDirectoryContext,
    directoryParentSourceId,
    setDirectoryParentSourceId,
    readmeSource,
    setReadmeSource,
    readmeContent,
    setReadmeContent,
    moveSource,
    setMoveSource,
    moveParentSourceId,
    setMoveParentSourceId,
    isSubmitting,
    handleToggle,
    handleToggleAllSources,
    handleStartRename,
    handleCancelRename,
    handleSubmitRename,
    handleRequestDeleteSource,
    handleConfirmDeleteSource,
    handleConfirmDeleteSelectedSources,
    handleRetrySource,
    handleReindexSource,
    handlePreviewSource,
    handleOpenReadmeDialog,
    handleOpenCreateDirectory,
    handleCreateDirectory,
    handleUpdateReadme,
    handleOpenMoveDialog,
    handleMoveSource,
    handleDownloadSource,
    handleCreateTextSource,
    handleCreateUrlSource,
    handleUploadFiles,
    handleDirectoryExpandedChange,
  } = useSources({
    workspaceId,
    currentWorkspaceIdRef,
    initialSources,
    initialSourcesLoaded,
    onSourceLoad,
    onSourceMerge,
    selectedIds,
    onSelectionChange,
    manualConnectorSyncSourcesRef,
    addSourceDialog,
  });
  refreshSourcesRef.current = refreshSources;
  const {
    connectors,
    connectorAccounts,
    isLoadingConnectors,
    connectorsLoadingError,
    connectorBusyById,
    connectorWaitingByType,
    isManageConnectorsOpen,
    setIsManageConnectorsOpen,
    manageConnectorsInitialTab,
    connectorReadinessById,
    pendingDisconnectConnector,
    setPendingDisconnectConnector,
    disconnectConnectorHardDelete,
    setDisconnectConnectorHardDelete,
    connectorWebhookEventsById,
    connectorWebhookConfigsById,
    setConnectorSettingsConnectorId,
    connectorSettingsActivity,
    isLoadingConnectorSettingsActivity,
    connectorSettingsActivityError,
    connectorSettingsConnector,
    refreshConnectors,
    openConnectorSettings,
    handleOpenConnectorSettingsById,
    openManageConnectors,
    handleConnectConnector,
    handleCreateConnector,
    handleRequestConnector,
    handleCancelConnector,
    handleCopyWebhook,
    handleSyncConnector,
    handleToggleConnectorStatus,
    handleSaveConnectorSettings,
    handleConfirmDisconnectConnector,
  } = useConnectors({
    workspaceId,
    currentWorkspaceIdRef,
    onConnectorsChange,
    trackConnectorSyncRun: stableTrackConnectorSyncRun,
    refreshSources: refreshSourcesForConnectors,
    sources,
    manualConnectorSyncSourcesRef,
  });
  const {
    citationScope,
    setCitationScope,
    currentCitationItems,
    threadCitationItems,
    activeCitationItems,
    filteredCitationItems,
    activeCitationChunkId,
  } = useCitations({
    mode,
    citations,
    threadCitations,
    activeCitationIndex,
    searchQuery: deferredSearchQueries.Citations,
  });
  const filteredSourceCount = useMemo(
    () => countFilteredSources(sources, deferredSearchQueries.Sources),
    [deferredSearchQueries.Sources, sources],
  );
  const filteredSkillCount = useMemo(
    () => countFilteredSkills(skillsForHub, deferredSearchQueries.Skills),
    [deferredSearchQueries.Skills, skillsForHub],
  );
  const skillIconsById = useMemo(
    () => buildHubSkillIconsById(skillsForHub, capabilityCatalog),
    [capabilityCatalog, skillsForHub],
  );
  const filteredWorkfileCount = useMemo(() => {
    const q = deferredSearchQueries.Workfiles.trim().toLowerCase();
    return q
      ? workfiles.filter((file) => workfileMatchesQuery(file, q)).length
      : workfiles.length;
  }, [deferredSearchQueries.Workfiles, workfiles]);
  const filteredArtifactCount = useMemo(() => {
    const q = deferredSearchQueries.Artifacts.trim().toLowerCase();
    return q
      ? artifacts.filter((artifact) => artifactMatchesQuery(artifact, q)).length
      : artifacts.length;
  }, [artifacts, deferredSearchQueries.Artifacts]);
  function setActiveSearchQuery(value: string) {
    setSearchQueries((current) => ({
      ...current,
      [activeTab]: value,
    }));
  }

  async function handleWorkspaceSkillEnabledChange(
    skill: HubSkillItem,
    enabled: boolean,
  ) {
    if (!workspaceId || !skill.workspaceSkillId) {
      return;
    }

    try {
      await contentClient.updateWorkspaceSkill(
        workspaceId,
        skill.workspaceSkillId,
        {
          enabled,
        },
      );
      if (!enabled && selectedSkillIds.includes(skill.id)) {
        onSkillSelectionChange(
          selectedSkillIds.filter((id) => id !== skill.id),
        );
      }
      await onSkillsCatalogChange?.();
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          enabled ? "Failed to enable skill." : "Failed to disable skill.",
        ),
      );
    }
  }

  function handleActiveTabChange(tab: HubTab) {
    setActiveTab(tab);
    persistHubTab(tab);
  }

  const updateTabScrollState = useCallback(() => {
    const strip = tabStripRef.current;
    if (!strip) {
      return;
    }

    const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const nextState = {
      canScrollLeft: strip.scrollLeft > 1,
      canScrollRight: strip.scrollLeft < maxScrollLeft - 1,
    };

    setTabScrollState((current) =>
      current.canScrollLeft === nextState.canScrollLeft &&
      current.canScrollRight === nextState.canScrollRight
        ? current
        : nextState,
    );
  }, []);

  const scrollTabStrip = useCallback((direction: "left" | "right") => {
    const strip = tabStripRef.current;
    if (!strip) {
      return;
    }
    const amount = Math.max(strip.clientWidth * 0.7, 120);
    strip.scrollBy({
      left: direction === "left" ? -amount : amount,
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    const storedTab = readStoredHubTab();
    if (storedTab) {
      setActiveTab(storedTab);
    }
  }, []);

  useEffect(() => {
    updateTabScrollState();
  });

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) {
      return;
    }

    updateTabScrollState();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateTabScrollState);

    resizeObserver?.observe(strip);
    for (const child of Array.from(strip.children)) {
      resizeObserver?.observe(child);
    }

    window.addEventListener("resize", updateTabScrollState);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateTabScrollState);
    };
  }, [updateTabScrollState]);

  useEffect(() => {
    currentWorkspaceIdRef.current = workspaceId;
    artifactOpenGenerationRef.current += 1;
    setOpeningArtifactId(null);
  }, [workspaceId]);

  const { trackConnectorSyncRun } = useConnectorSyncRuns({
    workspaceId,
    isPollingTab: shouldPollConnectorSyncRuns(activeTab),
    mergeIncrementalSources,
    replaceConnectorSources,
    refreshConnectors,
  });
  trackConnectorSyncRunRef.current = trackConnectorSyncRun;

  const tabCounts: Partial<Record<HubTab, number>> = {
    Sources: selectedSourceCoverageCount,
    Workfiles: workfiles.length,
    Artifacts: artifacts.length,
    Skills: selectedSkillIds.length,
    MCP: selectedMcpInstallIds.length + selectedMcpToolIds.length,
    Citations: citations.length,
    Connectors: connectors.length,
  };

  const handlePreviewArtifact = useCallback(
    async (artifact: ArtifactSummaryItem) => {
      if (!workspaceId || !onArtifactOpen) {
        return;
      }
      const activeWorkspaceId = workspaceId;
      const generation = artifactOpenGenerationRef.current + 1;
      artifactOpenGenerationRef.current = generation;
      setOpeningArtifactId(artifact.id);
      try {
        const detail = await loadArtifactDetail({
          workspaceId: activeWorkspaceId,
          summary: artifact,
        });
        if (
          artifactOpenGenerationRef.current === generation &&
          currentWorkspaceIdRef.current === activeWorkspaceId
        ) {
          onArtifactOpen(detail);
        }
      } catch (error) {
        if (artifactOpenGenerationRef.current === generation) {
          toast.error(getErrorMessage(error, "Could not load the artifact."));
        }
      } finally {
        if (artifactOpenGenerationRef.current === generation) {
          setOpeningArtifactId(null);
        }
      }
    },
    [onArtifactOpen, workspaceId],
  );

  return (
    <>
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col overflow-x-hidden bg-background",
          variant === "drawer" ? "w-full min-w-0" : "w-[410px] border-l",
        )}
      >
        <div className="min-w-0 shrink-0 border-b px-3 py-3">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">Hub</h2>
            <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5">
              {pendingSourceIds.length > 0 ? (
                <span className="inline-flex max-w-32 items-center gap-1 truncate text-[10px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  syncing {pendingSourceIds.length}
                </span>
              ) : null}
              {onClose ? (
                <Button
                  aria-label="Close Hub"
                  className="size-7"
                  onClick={onClose}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>

          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 rounded-xl bg-muted/35 pr-8 pl-8 text-xs sm:pr-20"
              onChange={(e) => setActiveSearchQuery(e.target.value)}
              placeholder={searchPlaceholders[activeTab]}
              value={searchQuery}
            />
            <span className="pointer-events-none absolute top-1/2 right-7 hidden -translate-y-1/2 rounded-md bg-background/75 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border/60 sm:inline-flex">
              {searchScopeLabels[activeTab]}
            </span>
            {searchQuery && (
              <button
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setActiveSearchQuery("")}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="relative mt-2 border-t pt-2">
            <div
              className="subtle-scrollbar flex max-w-full flex-nowrap gap-1 overflow-x-auto overscroll-x-contain"
              onScroll={updateTabScrollState}
              ref={tabStripRef}
            >
              {tabs.map((tab) => (
                <button
                  className={cn(
                    "inline-flex shrink-0 items-center justify-center rounded-lg border px-2 py-1 text-[11px] whitespace-nowrap transition-colors",
                    activeTab === tab
                      ? "border-border bg-secondary text-foreground shadow-xs"
                      : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  key={tab}
                  onClick={() => handleActiveTabChange(tab)}
                  type="button"
                >
                  <span>{tab}</span>
                  {tabCounts[tab] !== undefined ? (
                    <span className="ml-1.5 text-[10px] text-current/70">
                      {tabCounts[tab]}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-2 bottom-0 left-0 w-8 bg-gradient-to-r from-background via-background/85 to-transparent opacity-0 transition-opacity",
                tabScrollState.canScrollLeft && "opacity-100",
              )}
            />
            <button
              aria-label="Scroll tabs left"
              className={cn(
                "absolute top-2 bottom-0 left-0 flex items-center pr-2 text-muted-foreground transition-opacity hover:text-foreground",
                tabScrollState.canScrollLeft
                  ? "opacity-100"
                  : "pointer-events-none opacity-0",
              )}
              onClick={() => scrollTabStrip("left")}
              tabIndex={-1}
              type="button"
            >
              <ChevronLeft className="size-4 animate-scroll-hint-left" />
            </button>
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-2 right-0 bottom-0 w-8 bg-gradient-to-l from-background via-background/90 to-transparent opacity-0 transition-opacity",
                tabScrollState.canScrollRight && "opacity-100",
              )}
            />
            <button
              aria-label="Scroll tabs right"
              className={cn(
                "absolute top-2 right-0 bottom-0 flex items-center pl-2 text-muted-foreground transition-opacity hover:text-foreground",
                tabScrollState.canScrollRight
                  ? "opacity-100"
                  : "pointer-events-none opacity-0",
              )}
              onClick={() => scrollTabStrip("right")}
              tabIndex={-1}
              type="button"
            >
              <ChevronRight className="size-4 animate-scroll-hint-right" />
            </button>
          </div>
        </div>

        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-x-hidden px-3 py-3",
            activeTab === "Sources" ? "overflow-hidden" : "overflow-y-auto",
          )}
        >
          {activeTab === "Sources" && (
            <section className="flex h-full min-h-0 flex-col space-y-1">
              <div className="mb-2 flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Sources
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {sources.length}
                  </span>
                  {deferredSearchQueries.Sources ? (
                    <span className="text-[10px] text-primary">
                      {filteredSourceCount} found
                    </span>
                  ) : null}
                </div>
                <div className="flex min-h-8 shrink-0 items-center justify-end gap-1.5">
                  <Button
                    disabled={isLoading}
                    onClick={() => void refreshSources()}
                    size="icon-xs"
                    title="Refresh sources"
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcw
                      className={cn("size-3.5", isLoading && "animate-spin")}
                    />
                    <span className="sr-only">Refresh sources</span>
                  </Button>
                  <Button
                    disabled={selectableSourceIds.length === 0}
                    onClick={handleToggleAllSources}
                    size="icon-xs"
                    title={
                      allSelectableSourcesSelected
                        ? "Unselect all sources"
                        : "Select all sources"
                    }
                    type="button"
                    variant="ghost"
                  >
                    {allSelectableSourcesSelected ? (
                      <SquareMinus className="size-3.5" />
                    ) : (
                      <SquareCheckBig className="size-3.5" />
                    )}
                    <span className="sr-only">
                      {allSelectableSourcesSelected
                        ? "Unselect all sources"
                        : "Select all sources"}
                    </span>
                  </Button>
                  <Button
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={
                      selectedSourceIdsForBulkDelete.length === 0 ||
                      isDeletingSelectedSources
                    }
                    onClick={() => setDeleteSelectedSourcesOpen(true)}
                    size="icon-xs"
                    title="Delete selected sources"
                    type="button"
                    variant="ghost"
                  >
                    {isDeletingSelectedSources ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    <span className="sr-only">Delete selected sources</span>
                  </Button>
                  <Button
                    onClick={() => handleOpenCreateDirectory(null)}
                    size="icon-xs"
                    title="Create folder"
                    type="button"
                    variant="ghost"
                  >
                    <FolderPlus className="size-3.5" />
                    <span className="sr-only">Create folder</span>
                  </Button>
                  <Button
                    onClick={() => addSourceDialog.open(null)}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    <Upload className="size-3.5" />
                    Add source
                  </Button>
                </div>
              </div>

              {loadingError ? (
                <Alert className="mb-2" variant="destructive">
                  <AlertDescription>{loadingError}</AlertDescription>
                </Alert>
              ) : null}

              {isLoading ? (
                <div className="flex min-h-0 flex-1 items-center justify-center py-6 text-xs text-muted-foreground">
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Loading sources...
                </div>
              ) : (
                <div className="min-h-0 flex-1">
                  <SourcesTab
                    editingId={editingSourceId}
                    editingTitle={editingTitle}
                    expandedDirectoryIds={expandedDirectoryIds}
                    onCancelRename={handleCancelRename}
                    onDelete={handleRequestDeleteSource}
                    onDownload={handleDownloadSource}
                    onEditReadme={handleOpenReadmeDialog}
                    onEditTitleChange={setEditingTitle}
                    onAddSource={addSourceDialog.open}
                    onCreateDirectory={handleOpenCreateDirectory}
                    onDirectoryExpandedChange={handleDirectoryExpandedChange}
                    onMove={handleOpenMoveDialog}
                    onPreview={handlePreviewSource}
                    onReindex={handleReindexSource}
                    onRetry={handleRetrySource}
                    onOpenConnectorSettings={handleOpenConnectorSettingsById}
                    onStartRename={handleStartRename}
                    onSubmitRename={handleSubmitRename}
                    onToggle={handleToggle}
                    rowBusyById={rowBusyById}
                    searchQuery={deferredSearchQuery}
                    selectedIds={selectedIds}
                    sourceTreeIndex={sourceTreeIndex}
                    userCollapsedDirectoryIds={userCollapsedDirectoryIds}
                  />
                </div>
              )}
            </section>
          )}

          {activeTab === "Workfiles" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Workfiles
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {workfiles.length} workfiles
                  </span>
                  {deferredSearchQueries.Workfiles ? (
                    <span className="text-[10px] text-primary">
                      {filteredWorkfileCount} found
                    </span>
                  ) : null}
                </div>
                <Button
                  onClick={() => void refreshWorkfiles()}
                  size="icon-xs"
                  title="Refresh workfiles"
                  type="button"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" />
                  <span className="sr-only">Refresh workfiles</span>
                </Button>
              </div>
              <WorkfilesTab
                files={workfiles}
                isLoading={isLoadingWorkfiles}
                loadingError={workfilesLoadingError}
                onDelete={setDeleteWorkfile}
                onOpen={handleOpenWorkfile}
                onRefresh={() => void refreshWorkfiles()}
                rowBusyByPath={workfileBusyByPath}
                searchQuery={deferredSearchQuery}
              />
            </section>
          )}

          {activeTab === "Artifacts" && (
            <section className="space-y-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Artifacts
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {artifacts.length} artifacts
                  </span>
                  {deferredSearchQueries.Artifacts ? (
                    <span className="text-[10px] text-primary">
                      {filteredArtifactCount} found
                    </span>
                  ) : null}
                </div>
                <Button
                  className="size-7"
                  onClick={() => void refreshArtifacts()}
                  size="icon-xs"
                  title="Refresh artifacts"
                  type="button"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" />
                  <span className="sr-only">Refresh artifacts</span>
                </Button>
              </div>
              <ArtifactsTab
                artifacts={artifacts}
                hasMore={Boolean(artifactsNextCursor)}
                isLoading={isLoadingArtifacts}
                isLoadingMore={isLoadingMoreArtifacts}
                loadingError={artifactsLoadingError}
                onLoadMore={() => void loadMoreArtifacts()}
                onPreview={handlePreviewArtifact}
                openingArtifactId={openingArtifactId}
                onRefresh={() => void refreshArtifacts()}
                searchQuery={deferredSearchQuery}
                workspaceId={workspaceId}
              />
            </section>
          )}

          {activeTab === "Skills" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">
                    Skills
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {skillsForHub.length} available
                  </span>
                  {deferredSearchQueries.Skills ? (
                    <span className="text-[10px] text-primary">
                      {filteredSkillCount} found
                    </span>
                  ) : null}
                  {selectedSkillIds.length > 0 ? (
                    <span className="text-[10px] text-primary">
                      {selectedSkillIds.length} selected
                    </span>
                  ) : null}
                </div>
                <Button
                  onClick={() => setIsSkillsGalleryOpen(true)}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  <SkillIcon className="size-3.5" />
                  Skills gallery
                </Button>
              </div>

              <SkillsTab
                disabledToolNames={disabledToolNames}
                onOpenSkill={setPreviewSkillCatalogId}
                onSkillSelectionChange={onSkillSelectionChange}
                onWorkspaceSkillEnabledChange={
                  handleWorkspaceSkillEnabledChange
                }
                searchQuery={deferredSearchQuery}
                selectedSkillIds={selectedSkillIds}
                skillIconsById={skillIconsById}
                skills={skillsForHub}
              />
            </section>
          )}

          {activeTab === "MCP" && (
            <section className="space-y-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-medium text-foreground">MCP</h3>
                  <span className="text-[10px] text-muted-foreground">
                    {mcpInstalls.length} installed
                  </span>
                  {selectedMcpInstallIds.length + selectedMcpToolIds.length >
                  0 ? (
                    <span className="text-[10px] text-primary">
                      {selectedMcpInstallIds.length + selectedMcpToolIds.length}{" "}
                      selected
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    onClick={() => void refreshMcpInstalls()}
                    size="icon-xs"
                    title="Refresh MCP tools"
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcw
                      className={cn("size-3.5", isLoadingMcp && "animate-spin")}
                    />
                    <span className="sr-only">Refresh MCP tools</span>
                  </Button>
                  <Button
                    onClick={() => setIsMcpMarketOpen(true)}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    <McpIcon className="size-3.5" />
                    MCP Market
                  </Button>
                </div>
              </div>

              <McpTab
                installs={mcpInstalls}
                isLoading={isLoadingMcp}
                loadingError={mcpLoadingError}
                onSelectionChange={onMcpSelectionChange}
                searchQuery={deferredSearchQuery}
                selectedInstallIds={selectedMcpInstallIds}
                selectedToolIds={selectedMcpToolIds}
              />
            </section>
          )}

          {activeTab === "Citations" && (
            <CitationsTab
              activeCitationChunkId={activeCitationChunkId}
              activeCitationIndex={activeCitationIndex}
              activeCitationItems={activeCitationItems}
              citationScope={citationScope}
              currentCitationItems={currentCitationItems}
              currentCitationMessageId={currentCitationMessageId}
              filteredCitationItems={filteredCitationItems}
              mode={mode}
              onCitationLocate={onCitationLocate}
              onCitationOpen={onCitationOpen}
              onScopeChange={setCitationScope}
              searchQuery={deferredSearchQueries.Citations}
              threadCitationItems={threadCitationItems}
            />
          )}

          {activeTab === "Connectors" && (
            <ConnectorsTab
              connectorBusyById={connectorBusyById}
              connectorReadinessById={connectorReadinessById}
              connectors={connectors}
              isLoading={isLoadingConnectors}
              loadingError={connectorsLoadingError}
              onConfigureConnector={openConnectorSettings}
              onManageConnectors={() => openManageConnectors("all")}
              onSyncConnector={(connector) =>
                void handleSyncConnector(connector)
              }
              onToggleConnectorStatus={(connector) =>
                void handleToggleConnectorStatus(connector)
              }
              webhookConfigsById={connectorWebhookConfigsById}
            />
          )}
        </div>
      </aside>

      <ManageConnectorsDialog
        accounts={connectorAccounts}
        connectorBusyById={connectorBusyById}
        connectorReadinessById={connectorReadinessById}
        connectors={connectors}
        connectorWaitingByType={connectorWaitingByType}
        initialTab={manageConnectorsInitialTab}
        isLoading={isLoadingConnectors}
        loadingError={connectorsLoadingError}
        onCancelConnector={handleCancelConnector}
        onConnectConnector={handleConnectConnector}
        onCopyWebhook={handleCopyWebhook}
        onCreateConnector={(item) => void handleCreateConnector(item)}
        onDisconnectConnector={setPendingDisconnectConnector}
        onOpenChange={setIsManageConnectorsOpen}
        onOpenSettings={openConnectorSettings}
        onRequestConnector={handleRequestConnector}
        onSyncConnector={(connector) => void handleSyncConnector(connector)}
        onToggleConnectorStatus={(connector) =>
          void handleToggleConnectorStatus(connector)
        }
        open={isManageConnectorsOpen}
        webhookConfigsById={connectorWebhookConfigsById}
        webhookEventsByConnectorId={connectorWebhookEventsById}
      />

      <ConnectorSettingsDialog
        activity={connectorSettingsActivity}
        activityError={connectorSettingsActivityError}
        connector={connectorSettingsConnector}
        connectorBusyById={connectorBusyById}
        connectorReadinessById={connectorReadinessById}
        isLoadingActivity={isLoadingConnectorSettingsActivity}
        onCopyWebhook={handleCopyWebhook}
        onDisconnect={setPendingDisconnectConnector}
        onOpenChange={(open) => {
          if (!open) {
            setConnectorSettingsConnectorId(null);
          }
        }}
        onSaveSettings={(connector, input) =>
          void handleSaveConnectorSettings(connector, input)
        }
        onSyncConnector={(connector) => void handleSyncConnector(connector)}
        onToggleStatus={(connector) =>
          void handleToggleConnectorStatus(connector)
        }
        open={Boolean(connectorSettingsConnector)}
        webhookConfig={
          connectorSettingsConnector
            ? (connectorWebhookConfigsById[connectorSettingsConnector.id] ??
              null)
            : null
        }
      />

      <AddSourceDialog
        addParentSourceId={addSourceDialog.parentSourceId}
        addTab={addSourceDialog.tab}
        fileInputRef={addSourceDialog.fileInputRef}
        files={addSourceDialog.files}
        isDragActive={addSourceDialog.isDragActive}
        isOpen={addSourceDialog.isOpen}
        isSubmitting={isSubmitting}
        onAddFiles={addSourceDialog.addFiles}
        onAddTabChange={addSourceDialog.setTab}
        onClose={addSourceDialog.close}
        onCreateTextSource={() => void handleCreateTextSource()}
        onCreateUrlSource={() => void handleCreateUrlSource()}
        onDragEnter={addSourceDialog.handleDragEnter}
        onDragLeave={addSourceDialog.handleDragLeave}
        onDragOver={addSourceDialog.handleDragOver}
        onDrop={addSourceDialog.handleDrop}
        onRemoveFile={addSourceDialog.removeFile}
        onTextContentChange={addSourceDialog.setTextContent}
        onTextTitleChange={addSourceDialog.setTextTitle}
        onUploadFiles={() => void handleUploadFiles()}
        onUrlTitleChange={addSourceDialog.setUrlTitle}
        onUrlValueChange={addSourceDialog.setUrlValue}
        sources={sources}
        textContent={addSourceDialog.textContent}
        textTitle={addSourceDialog.textTitle}
        uploadProgress={addSourceDialog.uploadProgress}
        urlTitle={addSourceDialog.urlTitle}
        urlValue={addSourceDialog.urlValue}
      />

      <CreateDirectoryDialog
        directoryContext={directoryContext}
        directoryParentSourceId={directoryParentSourceId}
        directoryTitle={directoryTitle}
        isOpen={isCreateDirectoryOpen}
        isSubmitting={isSubmitting}
        onContextChange={setDirectoryContext}
        onCreate={() => void handleCreateDirectory()}
        onOpenChange={setIsCreateDirectoryOpen}
        onParentChange={setDirectoryParentSourceId}
        onTitleChange={setDirectoryTitle}
        sources={sources}
      />

      <MoveSourceDialog
        isSubmitting={isSubmitting}
        moveParentSourceId={moveParentSourceId}
        moveSource={moveSource}
        onMove={() => void handleMoveSource()}
        onMoveSourceChange={setMoveParentSourceId}
        onOpenChange={(open) => {
          if (!open) {
            setMoveSource(null);
            setMoveParentSourceId(null);
          }
        }}
        sources={sources}
      />

      <ReadmeDialog
        isSubmitting={isSubmitting}
        onContentChange={setReadmeContent}
        onOpenChange={(open) => {
          if (!open) {
            setReadmeSource(null);
            setReadmeContent("");
          }
        }}
        onSave={() => void handleUpdateReadme()}
        readmeContent={readmeContent}
        readmeSource={readmeSource}
      />

      <SourcePreviewPanel
        onOpenChange={(open) => {
          if (!open) {
            setPreviewSource(null);
          }
        }}
        open={Boolean(previewSource)}
        source={previewSource}
        workspaceId={workspaceId}
      />

      <WorkfilePreviewDialog
        onOpenChange={(open) => {
          if (!open) {
            setPreviewWorkfile(null);
          }
        }}
        previewWorkfile={previewWorkfile}
      />

      <DeleteSourceDialog
        deleteSource={deleteSource}
        onConfirm={(source) => void handleConfirmDeleteSource(source)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteSource(null);
          }
        }}
        rowBusyById={rowBusyById}
      />

      <DeleteSelectedSourcesDialog
        count={selectedSourceIdsForBulkDelete.length}
        isDeleting={isDeletingSelectedSources}
        onConfirm={() => void handleConfirmDeleteSelectedSources()}
        onOpenChange={(open) => {
          if (!isDeletingSelectedSources) {
            setDeleteSelectedSourcesOpen(open);
          }
        }}
        open={deleteSelectedSourcesOpen}
      />

      <DeleteWorkfileDialog
        deleteWorkfile={deleteWorkfile}
        onConfirm={() => void handleConfirmDeleteWorkfile()}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteWorkfile(null);
          }
        }}
        workfileBusyByPath={workfileBusyByPath}
      />

      <ConnectorDisconnectDialog
        connector={pendingDisconnectConnector}
        hardDelete={disconnectConnectorHardDelete}
        isBusy={Boolean(
          pendingDisconnectConnector &&
          connectorBusyById[pendingDisconnectConnector.id],
        )}
        onConfirm={() => void handleConfirmDisconnectConnector()}
        onHardDeleteChange={setDisconnectConnectorHardDelete}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDisconnectConnector(null);
            setDisconnectConnectorHardDelete(false);
          }
        }}
      />

      <SkillReadmeDialog
        catalogId={previewSkillCatalogId}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewSkillCatalogId(null);
          }
        }}
        open={Boolean(previewSkillCatalogId)}
        workspaceId={workspaceId}
      />

      <Dialog onOpenChange={setIsSkillsGalleryOpen} open={isSkillsGalleryOpen}>
        <DialogContent
          className="grid h-[min(780px,calc(100svh-2rem))] w-[min(1240px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
          constrainWidth={false}
        >
          <DialogHeader className="border-b px-5 py-4 text-left">
            <DialogTitle>Skills gallery</DialogTitle>
            <DialogDescription>
              Install reusable skills for{" "}
              {workspaceName || "the current workspace"}.
            </DialogDescription>
          </DialogHeader>
          <SkillsGallery
            className="min-h-0"
            lockWorkspace
            onCatalogChange={onSkillsCatalogChange}
            variant="modal"
            workspaceId={workspaceId}
            workspaceName={workspaceName}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          setIsMcpMarketOpen(open);
          // Reflect any installs/credentials changed in the market back into the
          // MCP tab as soon as the dialog is dismissed.
          if (!open) {
            void refreshMcpInstalls();
          }
        }}
        open={isMcpMarketOpen}
      >
        <DialogContent
          className="grid h-[min(780px,calc(100svh-2rem))] w-[min(1240px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
          constrainWidth={false}
        >
          <DialogHeader className="border-b px-5 py-4 text-left">
            <DialogTitle>MCP Market</DialogTitle>
            <DialogDescription>
              Install and configure MCP servers for{" "}
              {workspaceName || "the current workspace"}.
            </DialogDescription>
          </DialogHeader>
          {/* Flex + clip so McpMarket's flex-1 gets a bounded height and its own
              ScrollAreas handle scrolling — the filter sidebar stays fixed while
              only the card grid scrolls. overflow-auto here let the whole panel
              scroll as one, dragging the sidebar out of view. */}
          <div className="flex min-h-0 overflow-hidden">
            <McpMarket />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
