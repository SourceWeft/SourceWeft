import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { apiBaseUrl, contentClient } from "../../../../../../lib/sdk";
import { expandSelectedSources, type SourceItem } from "../../source-types";
import {
  buildSourceTree,
  buildSourceTreeFromIndex,
  buildSourceTreeIndex,
  collectSelectableSourceIds,
  collectTreeIds,
  findNodePath,
  isSelectableSource,
  isSyncingSource,
  normalizeSourceSelectionFromTree,
  toggleSourceSelectionInTree,
  type SourceTreeNode,
} from "../source-tree";
import {
  persistSourceTreeExpansion as persistSourceTreeExpansionStorage,
  readStoredSourceTreeExpansion as readStoredSourceTreeExpansionStorage,
} from "../storage";
import { mapSourcesToUi } from "../source-mapping";
import { resolveWorkspaceSourceHydration } from "../source-refresh-state";
import { areStringArraysEqual } from "../lib/format";
import { getErrorMessage } from "../lib/errors";
import type { useAddSourceDialogState } from "./use-add-source-dialog";

const SOURCE_TREE_EXPANSION_STORAGE_PREFIX = "chat:sources-hub:source-tree:v1";

function readStoredSourceTreeExpansion(workspaceId?: string | null) {
  return readStoredSourceTreeExpansionStorage(
    SOURCE_TREE_EXPANSION_STORAGE_PREFIX,
    workspaceId,
  );
}

function persistSourceTreeExpansion(input: {
  workspaceId?: string | null;
  expandedDirectoryIds: Set<string>;
  userCollapsedDirectoryIds: Set<string>;
}) {
  persistSourceTreeExpansionStorage({
    ...input,
    storagePrefix: SOURCE_TREE_EXPANSION_STORAGE_PREFIX,
  });
}

function appendUniqueSources(current: SourceItem[], incoming: SourceItem[]) {
  const mergedById = new Map(current.map((source) => [source.id, source]));
  for (const source of incoming) {
    const existing = mergedById.get(source.id);
    if (!existing) {
      mergedById.set(source.id, source);
      continue;
    }
    const existingTime = existing.updatedAt
      ? Date.parse(existing.updatedAt)
      : 0;
    const incomingTime = source.updatedAt ? Date.parse(source.updatedAt) : 0;
    if (incomingTime >= existingTime) {
      mergedById.set(source.id, { ...existing, ...source });
    }
  }
  return Array.from(mergedById.values());
}

const upsertSources = appendUniqueSources;

function mergeSourceSelectionFromTree(
  nodes: SourceTreeNode[],
  selectedIds: string[],
  sourceIdsToAdd: string[],
) {
  if (sourceIdsToAdd.length === 0) {
    return selectedIds;
  }

  const nextIds = normalizeSourceSelectionFromTree(
    nodes,
    Array.from(new Set([...selectedIds, ...sourceIdsToAdd])),
  );

  return areStringArraysEqual(nextIds, selectedIds) ? selectedIds : nextIds;
}

function countSelectedSourceCoverage(
  tree: SourceTreeNode[],
  selectedIds: string[],
) {
  const selectedSet = new Set(selectedIds);
  const countedIds = new Set<string>();
  let count = 0;

  function visit(node: SourceTreeNode, coveredByAncestor: boolean) {
    const selected = selectedSet.has(node.source.id);
    const covered = coveredByAncestor || selected;

    if (
      covered &&
      isSelectableSource(node.source) &&
      !countedIds.has(node.source.id)
    ) {
      countedIds.add(node.source.id);
      count += 1;
    }

    for (const child of node.children) {
      visit(child, covered);
    }
  }

  for (const node of tree) {
    visit(node, false);
  }
  return count;
}

export function useSources(input: {
  workspaceId?: string | null;
  currentWorkspaceIdRef: { current: string | null | undefined };
  initialSources: SourceItem[];
  initialSourcesLoaded: boolean;
  onSourceLoad?: (sources: SourceItem[]) => void;
  onSourceMerge?: (sources: SourceItem[]) => void;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  manualConnectorSyncSourcesRef: {
    current: Map<string, { knownSourceIds: Set<string> }>;
  };
  addSourceDialog: ReturnType<typeof useAddSourceDialogState>;
}) {
  const {
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
  } = input;

  const [sources, setSources] = useState<SourceItem[]>(initialSources);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const resetAddSourceDialog = addSourceDialog.reset;
  const [isCreateDirectoryOpen, setIsCreateDirectoryOpen] = useState(false);
  const [directoryTitle, setDirectoryTitle] = useState("");
  const [directoryContext, setDirectoryContext] = useState("");
  const [directoryParentSourceId, setDirectoryParentSourceId] = useState<
    string | null
  >(null);
  const [readmeSource, setReadmeSource] = useState<SourceItem | null>(null);
  const [readmeContent, setReadmeContent] = useState("");
  const [moveSource, setMoveSource] = useState<SourceItem | null>(null);
  const [moveParentSourceId, setMoveParentSourceId] = useState<string | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const loadedSourcesWorkspaceIdRef = useRef<string | null>(null);
  const initializedSourcesWorkspaceIdRef = useRef<string | null>(null);
  const sourcesRef = useRef<SourceItem[]>(initialSources);
  const selectedIdsRef = useRef<string[]>(selectedIds);
  const pendingAutoSelectSourceIdsRef = useRef<Set<string>>(new Set());
  const [pendingSourceIds, setPendingSourceIds] = useState<string[]>([]);

  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [rowBusyById, setRowBusyById] = useState<Record<string, boolean>>({});
  const [previewSource, setPreviewSource] = useState<SourceItem | null>(null);
  const [deleteSource, setDeleteSource] = useState<SourceItem | null>(null);
  const [deleteSelectedSourcesOpen, setDeleteSelectedSourcesOpen] =
    useState(false);
  const [isDeletingSelectedSources, setIsDeletingSelectedSources] =
    useState(false);
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(
    () => readStoredSourceTreeExpansion(workspaceId).expandedDirectoryIds,
  );
  const [userCollapsedDirectoryIds, setUserCollapsedDirectoryIds] = useState<
    Set<string>
  >(() => readStoredSourceTreeExpansion(workspaceId).userCollapsedDirectoryIds);
  const expandedDirectoryIdsRef = useRef<Set<string>>(expandedDirectoryIds);
  const userCollapsedDirectoryIdsRef = useRef<Set<string>>(
    userCollapsedDirectoryIds,
  );
  const expansionWorkspaceIdRef = useRef<string | null | undefined>(
    workspaceId,
  );
  const sourceTreeIndex = useMemo(
    () => buildSourceTreeIndex(sources),
    [sources],
  );
  const fullSourceTree = useMemo(
    () => buildSourceTreeFromIndex(sourceTreeIndex, ""),
    [sourceTreeIndex],
  );
  const selectableSourceIds = useMemo(
    () => collectSelectableSourceIds(fullSourceTree),
    [fullSourceTree],
  );
  const selectedLibrarySources = useMemo(
    () => expandSelectedSources(sources, selectedIds),
    [selectedIds, sources],
  );
  const selectedSourceCoverageCount = useMemo(
    () => countSelectedSourceCoverage(fullSourceTree, selectedIds),
    [fullSourceTree, selectedIds],
  );
  const selectedSourceIdsForBulkDelete = useMemo(() => {
    const selectedSet = new Set(
      selectedLibrarySources.map((source) => source.id),
    );
    const coveredByAncestor = new Set<string>();
    const visit = (node: SourceTreeNode, ancestorSelected: boolean) => {
      const isSelected = selectedSet.has(node.source.id);
      if (ancestorSelected && isSelected) {
        coveredByAncestor.add(node.source.id);
      }
      for (const child of node.children) {
        visit(child, ancestorSelected || isSelected);
      }
    };
    for (const node of fullSourceTree) {
      visit(node, false);
    }
    return selectedLibrarySources
      .map((source) => source.id)
      .filter((id) => !coveredByAncestor.has(id));
  }, [fullSourceTree, selectedLibrarySources]);
  const allSelectableSourcesSelected =
    selectableSourceIds.length > 0 &&
    selectedLibrarySources.length >= selectableSourceIds.length;

  selectedIdsRef.current = selectedIds;

  const commitSources = useCallback((nextSources: SourceItem[]) => {
    sourcesRef.current = nextSources;
    setSources(nextSources);
  }, []);

  const selectNewSourceIds = useCallback(
    (sourceIds: string[], sourceTree: SourceTreeNode[] = fullSourceTree) => {
      for (const sourceId of sourceIds) {
        pendingAutoSelectSourceIdsRef.current.add(sourceId);
      }

      const currentSelectedIds = selectedIdsRef.current;
      const nextSelectedIds = mergeSourceSelectionFromTree(
        sourceTree,
        currentSelectedIds,
        sourceIds,
      );
      if (!areStringArraysEqual(nextSelectedIds, currentSelectedIds)) {
        selectedIdsRef.current = nextSelectedIds;
        onSelectionChange(nextSelectedIds);
      }

      for (const sourceId of nextSelectedIds) {
        pendingAutoSelectSourceIdsRef.current.delete(sourceId);
      }
    },
    [fullSourceTree, onSelectionChange],
  );

  const selectPendingAutoSources = useCallback(
    (nextSources: SourceItem[]) => {
      if (pendingAutoSelectSourceIdsRef.current.size === 0) {
        return;
      }

      const availableSourceIds = new Set(
        nextSources.map((source) => source.id),
      );
      const sourceIdsToAdd = Array.from(
        pendingAutoSelectSourceIdsRef.current,
      ).filter((sourceId) => availableSourceIds.has(sourceId));
      if (sourceIdsToAdd.length === 0) {
        return;
      }

      const currentSelectedIds = selectedIdsRef.current;
      const sourceTree = buildSourceTree(nextSources, "");
      const nextSelectedIds = mergeSourceSelectionFromTree(
        sourceTree,
        currentSelectedIds,
        sourceIdsToAdd,
      );

      if (!areStringArraysEqual(nextSelectedIds, currentSelectedIds)) {
        selectedIdsRef.current = nextSelectedIds;
        onSelectionChange(nextSelectedIds);
      }

      const selectedSourceIds = new Set(
        expandSelectedSources(nextSources, nextSelectedIds).map(
          (source) => source.id,
        ),
      );
      for (const sourceId of sourceIdsToAdd) {
        if (selectedSourceIds.has(sourceId)) {
          pendingAutoSelectSourceIdsRef.current.delete(sourceId);
        }
      }
    },
    [onSelectionChange],
  );

  const selectNewManualConnectorSources = useCallback(
    (nextSources: SourceItem[]) => {
      if (manualConnectorSyncSourcesRef.current.size === 0) {
        return;
      }

      const sourceTree = buildSourceTree(nextSources, "");
      const currentSelectedIds = selectedIdsRef.current;
      let nextSelectedIds = currentSelectedIds;
      let changed = false;

      for (const [
        connectorId,
        tracked,
      ] of manualConnectorSyncSourcesRef.current) {
        const connectorSources = nextSources.filter(
          (source) => source.connectorId === connectorId,
        );
        const newSourceIds = connectorSources
          .filter((source) => !tracked.knownSourceIds.has(source.id))
          .map((source) => source.id);

        if (newSourceIds.length > 0) {
          for (const sourceId of newSourceIds) {
            pendingAutoSelectSourceIdsRef.current.add(sourceId);
          }
          nextSelectedIds = mergeSourceSelectionFromTree(
            sourceTree,
            nextSelectedIds,
            newSourceIds,
          );
          changed = true;
        }

        for (const source of connectorSources) {
          tracked.knownSourceIds.add(source.id);
        }
      }

      if (
        changed &&
        !areStringArraysEqual(nextSelectedIds, currentSelectedIds)
      ) {
        selectedIdsRef.current = nextSelectedIds;
        onSelectionChange(nextSelectedIds);
      }

      const selectedSourceIds = new Set(
        expandSelectedSources(nextSources, nextSelectedIds).map(
          (source) => source.id,
        ),
      );
      for (const sourceId of Array.from(
        pendingAutoSelectSourceIdsRef.current,
      )) {
        if (selectedSourceIds.has(sourceId)) {
          pendingAutoSelectSourceIdsRef.current.delete(sourceId);
        }
      }
    },
    [manualConnectorSyncSourcesRef, onSelectionChange],
  );

  useEffect(() => {
    expandedDirectoryIdsRef.current = expandedDirectoryIds;
    userCollapsedDirectoryIdsRef.current = userCollapsedDirectoryIds;
    if (expansionWorkspaceIdRef.current !== workspaceId) {
      return;
    }
    persistSourceTreeExpansion({
      workspaceId,
      expandedDirectoryIds,
      userCollapsedDirectoryIds,
    });
  }, [expandedDirectoryIds, userCollapsedDirectoryIds, workspaceId]);

  const autoExpandConnectorManagedDirectories = useCallback(
    (items: SourceItem[]) => {
      const directoryIds = items
        .filter(
          (source) =>
            source.sourceType === "directory" &&
            source.metadata?.connectorManagedDirectory === true,
        )
        .map((source) => source.id);
      if (directoryIds.length === 0) {
        return;
      }
      setExpandedDirectoryIds((current) => {
        let changed = false;
        const next = new Set(current);
        const collapsed = userCollapsedDirectoryIdsRef.current;
        for (const id of directoryIds) {
          if (!next.has(id) && !collapsed.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        if (changed) {
          expandedDirectoryIdsRef.current = next;
        }
        return changed ? next : current;
      });
    },
    [],
  );

  const refreshSources = useCallback(async () => {
    if (!workspaceId) {
      commitSources([]);
      onSourceLoad?.([]);
      loadedSourcesWorkspaceIdRef.current = null;
      return;
    }

    const activeWorkspaceId = workspaceId;
    const isInitialLoad =
      loadedSourcesWorkspaceIdRef.current !== activeWorkspaceId ||
      sourcesRef.current.length === 0;
    setIsLoading(true);
    setLoadingError(null);
    if (isInitialLoad) {
      commitSources([]);
    }
    try {
      const result = await contentClient.listSources(activeWorkspaceId, {
        view: "tree",
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      const mapped = mapSourcesToUi(result.items);
      commitSources(mapped);
      autoExpandConnectorManagedDirectories(mapped);
      loadedSourcesWorkspaceIdRef.current = activeWorkspaceId;
      onSourceLoad?.(mapped);
      onSourceMerge?.(mapped);
      selectPendingAutoSources(mapped);
      selectNewManualConnectorSources(mapped);

      const syncing = result.items
        .filter(
          (item) => item.status === "queued" || item.status === "processing",
        )
        .map((item) => item.id);
      if (syncing.length > 0) {
        setPendingSourceIds((prev) =>
          Array.from(new Set([...prev, ...syncing])),
        );
      }
    } catch (error) {
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      const message = getErrorMessage(error, "Failed to load sources.");
      setLoadingError(message);
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoading(false);
      }
    }
  }, [
    autoExpandConnectorManagedDirectories,
    commitSources,
    currentWorkspaceIdRef,
    onSourceLoad,
    onSourceMerge,
    selectPendingAutoSources,
    selectNewManualConnectorSources,
    workspaceId,
  ]);

  const handleDirectoryExpandedChange = useCallback(
    (sourceId: string, open: boolean) => {
      const nextExpanded = new Set(expandedDirectoryIdsRef.current);
      const nextCollapsed = new Set(userCollapsedDirectoryIdsRef.current);
      if (open) {
        nextExpanded.add(sourceId);
        nextCollapsed.delete(sourceId);
      } else {
        nextExpanded.delete(sourceId);
        nextCollapsed.add(sourceId);
      }

      expandedDirectoryIdsRef.current = nextExpanded;
      userCollapsedDirectoryIdsRef.current = nextCollapsed;
      setExpandedDirectoryIds(nextExpanded);
      setUserCollapsedDirectoryIds(nextCollapsed);
      persistSourceTreeExpansion({
        workspaceId,
        expandedDirectoryIds: nextExpanded,
        userCollapsedDirectoryIds: nextCollapsed,
      });
    },
    [workspaceId],
  );

  const mergeIncrementalSources = useCallback(
    (mapped: SourceItem[]) => {
      if (mapped.length === 0) {
        return;
      }
      autoExpandConnectorManagedDirectories(mapped);
      const merged = upsertSources(sourcesRef.current, mapped);
      commitSources(merged);
      selectPendingAutoSources(merged);
      selectNewManualConnectorSources(merged);
      onSourceLoad?.(merged);
      onSourceMerge?.(mapped);
    },
    [
      autoExpandConnectorManagedDirectories,
      commitSources,
      onSourceLoad,
      onSourceMerge,
      selectNewManualConnectorSources,
      selectPendingAutoSources,
    ],
  );

  const replaceConnectorSources = useCallback(
    (batches: Array<{ connectorId: string; items: SourceItem[] }>) => {
      if (batches.length === 0) {
        return;
      }
      const connectorIds = new Set(batches.map((batch) => batch.connectorId));
      const mapped = batches.flatMap((batch) => batch.items);
      autoExpandConnectorManagedDirectories(mapped);
      const retained = sourcesRef.current.filter(
        (source) =>
          !source.connectorId || !connectorIds.has(source.connectorId),
      );
      const merged = upsertSources(retained, mapped);
      commitSources(merged);
      selectPendingAutoSources(merged);
      selectNewManualConnectorSources(merged);
      onSourceLoad?.(merged);
      if (mapped.length > 0) {
        onSourceMerge?.(mapped);
      }
    },
    [
      autoExpandConnectorManagedDirectories,
      commitSources,
      onSourceLoad,
      onSourceMerge,
      selectNewManualConnectorSources,
      selectPendingAutoSources,
    ],
  );

  useEffect(() => {
    const sourceHydration = resolveWorkspaceSourceHydration({
      initializedWorkspaceId: initializedSourcesWorkspaceIdRef.current,
      initialSources,
      initialSourcesLoaded,
      workspaceId,
    });

    if (sourceHydration.kind === "clear") {
      loadedSourcesWorkspaceIdRef.current = null;
      initializedSourcesWorkspaceIdRef.current =
        sourceHydration.initializedWorkspaceId;
      expansionWorkspaceIdRef.current = workspaceId;
      expandedDirectoryIdsRef.current = new Set();
      userCollapsedDirectoryIdsRef.current = new Set();
      setExpandedDirectoryIds(new Set());
      setUserCollapsedDirectoryIds(new Set());
      commitSources(sourceHydration.sources);
      setLoadingError(null);
      setIsLoading(false);
      setPendingSourceIds([]);
      return;
    }

    if (sourceHydration.kind === "skip") {
      return;
    }
    initializedSourcesWorkspaceIdRef.current =
      sourceHydration.initializedWorkspaceId;
    const storedExpansion = readStoredSourceTreeExpansion(workspaceId);
    expansionWorkspaceIdRef.current = workspaceId;
    expandedDirectoryIdsRef.current = storedExpansion.expandedDirectoryIds;
    userCollapsedDirectoryIdsRef.current =
      storedExpansion.userCollapsedDirectoryIds;
    setExpandedDirectoryIds(storedExpansion.expandedDirectoryIds);
    setUserCollapsedDirectoryIds(storedExpansion.userCollapsedDirectoryIds);

    setLoadingError(null);
    setPendingSourceIds([]);
    setEditingSourceId(null);
    setEditingTitle("");
    setRowBusyById({});
    setPreviewSource(null);
    setDeleteSource(null);
    setMoveSource(null);
    setMoveParentSourceId(null);
    setReadmeSource(null);
    setReadmeContent("");
    resetAddSourceDialog();
    setDirectoryParentSourceId(null);

    commitSources(sourceHydration.sources);
    void refreshSources();
  }, [
    commitSources,
    workspaceId,
    initialSources,
    initialSourcesLoaded,
    refreshSources,
    resetAddSourceDialog,
  ]);

  useEffect(() => {
    if (!workspaceId || pendingSourceIds.length === 0) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const { items: statuses } = await contentClient.listSourceStatuses(
          workspaceId,
          { ids: pendingSourceIds },
        );
        if (cancelled) {
          return;
        }

        const nextPending: string[] = [];
        let shouldRefresh = false;
        for (const result of statuses) {
          const current = result.status.status;
          if (current === "queued" || current === "processing") {
            nextPending.push(result.id);
            continue;
          }

          shouldRefresh = true;
          if (current === "failed") {
            toast.error("Source processing failed.");
          }
        }

        setPendingSourceIds(nextPending);
        if (shouldRefresh) {
          void refreshSources();
        }
      } catch {
        // Keep polling quietly; source listing refresh will surface errors.
      }
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, pendingSourceIds, refreshSources]);

  useEffect(() => {
    const syncingIds = sources
      .filter(isSyncingSource)
      .map((source) => source.id);
    if (syncingIds.length === 0) {
      return;
    }

    setPendingSourceIds((prev) => {
      const next = Array.from(new Set([...prev, ...syncingIds]));
      return next.length === prev.length ? prev : next;
    });
  }, [sources]);

  useEffect(() => {
    setEditingSourceId((prev) => {
      if (!prev) return prev;
      return sources.some((s) => s.id === prev) ? prev : null;
    });

    if (sources.length === 0) {
      return;
    }

    const sourceIds = new Set(sources.map((s) => s.id));
    const nextSelected = normalizeSourceSelectionFromTree(
      fullSourceTree,
      selectedIds.filter((id) => sourceIds.has(id)),
    );
    if (!areStringArraysEqual(nextSelected, selectedIds)) {
      onSelectionChange(nextSelected);
    }
  }, [fullSourceTree, sources, selectedIds, onSelectionChange]);

  function handleToggle(node: SourceTreeNode) {
    onSelectionChange(
      normalizeSourceSelectionFromTree(
        fullSourceTree,
        toggleSourceSelectionInTree(fullSourceTree, node, selectedIds),
      ),
    );
  }

  function handleToggleAllSources() {
    if (allSelectableSourcesSelected) {
      onSelectionChange([]);
      return;
    }

    onSelectionChange(
      normalizeSourceSelectionFromTree(fullSourceTree, selectableSourceIds),
    );
  }

  function setRowBusy(id: string, busy: boolean) {
    setRowBusyById((prev) => {
      if (busy) return { ...prev, [id]: true };
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  const handleStartRename = useCallback((source: SourceItem) => {
    setEditingSourceId(source.id);
    setEditingTitle(source.title);
  }, []);

  const handleCancelRename = useCallback(() => {
    setEditingSourceId(null);
    setEditingTitle("");
  }, []);

  const handleSubmitRename = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      const title = editingTitle.trim();
      if (!title) return;

      setRowBusy(id, true);
      try {
        await contentClient.updateSource(workspaceId, id, { title });
        toast.success("Source renamed.");
        setEditingSourceId(null);
        setEditingTitle("");
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to rename source."));
      } finally {
        setRowBusy(id, false);
      }
    },
    [workspaceId, editingTitle, refreshSources],
  );

  const handleRequestDeleteSource = useCallback((source: SourceItem) => {
    setDeleteSource(source);
  }, []);

  const handleConfirmDeleteSource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;

      setRowBusy(source.id, true);
      try {
        await contentClient.deleteSource(workspaceId, source.id);
        toast.success("Source deleted.");
        const deletedNode = findNodePath(fullSourceTree, source.id)?.at(-1);
        const deletedIds = new Set(
          deletedNode ? collectTreeIds(deletedNode) : [source.id],
        );
        onSelectionChange(selectedIds.filter((id) => !deletedIds.has(id)));
        setDeleteSource(null);
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to delete source."));
      } finally {
        setRowBusy(source.id, false);
      }
    },
    [
      workspaceId,
      fullSourceTree,
      refreshSources,
      onSelectionChange,
      selectedIds,
    ],
  );

  const handleConfirmDeleteSelectedSources = useCallback(async () => {
    if (!workspaceId || selectedSourceIdsForBulkDelete.length === 0) return;

    setIsDeletingSelectedSources(true);
    setRowBusyById((prev) => {
      const next = { ...prev };
      for (const sourceId of selectedSourceIdsForBulkDelete) {
        next[sourceId] = true;
      }
      return next;
    });
    try {
      const result = await contentClient.bulkDeleteSources(workspaceId, {
        sourceIds: selectedSourceIdsForBulkDelete,
      });
      const deletedIds = new Set<string>();
      for (const sourceId of result.sourceIds) {
        const node = findNodePath(fullSourceTree, sourceId)?.at(-1);
        for (const id of node ? collectTreeIds(node) : [sourceId]) {
          deletedIds.add(id);
        }
      }
      onSelectionChange(selectedIds.filter((id) => !deletedIds.has(id)));
      setDeleteSelectedSourcesOpen(false);
      toast.success(
        `Deleted ${result.deletedCount} selected source${
          result.deletedCount === 1 ? "" : "s"
        }.`,
      );
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to delete selected sources."));
    } finally {
      setIsDeletingSelectedSources(false);
      setRowBusyById((prev) => {
        const next = { ...prev };
        for (const sourceId of selectedSourceIdsForBulkDelete) {
          delete next[sourceId];
        }
        return next;
      });
    }
  }, [
    fullSourceTree,
    onSelectionChange,
    refreshSources,
    selectedIds,
    selectedSourceIdsForBulkDelete,
    workspaceId,
  ]);

  const handleRetrySource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;

      setRowBusy(source.id, true);
      try {
        await contentClient.retrySource(workspaceId, source.id, {});
        setPendingSourceIds((prev) =>
          prev.includes(source.id) ? prev : [...prev, source.id],
        );
        toast.success("Source retry queued.");
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to retry source."));
      } finally {
        setRowBusy(source.id, false);
      }
    },
    [workspaceId, refreshSources],
  );

  const handleReindexSource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;

      setRowBusy(source.id, true);
      try {
        await contentClient.indexSource(workspaceId, source.id, {});
        setPendingSourceIds((prev) =>
          prev.includes(source.id) ? prev : [...prev, source.id],
        );
        toast.success("Re-index queued.");
        await refreshSources();
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to re-index source."));
      } finally {
        setRowBusy(source.id, false);
      }
    },
    [workspaceId, refreshSources],
  );

  const handlePreviewSource = useCallback((source: SourceItem) => {
    if (source.sourceType === "directory") return;
    setPreviewSource(source);
  }, []);

  const handleOpenReadmeDialog = useCallback(
    async (source: SourceItem) => {
      if (source.sourceType !== "directory") return;
      setReadmeSource(source);
      setReadmeContent(source.contentText);

      if (!workspaceId) return;

      try {
        const detail = await contentClient.getSource(workspaceId, source.id);
        setReadmeContent(detail.source.contentText);
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to load README content."));
      }
    },
    [workspaceId],
  );

  const handleOpenCreateDirectory = useCallback(
    (parentSourceId: string | null = null) => {
      setDirectoryParentSourceId(parentSourceId);
      setDirectoryTitle("");
      setDirectoryContext("");
      setIsCreateDirectoryOpen(true);
    },
    [],
  );

  const handleCreateDirectory = useCallback(async () => {
    if (!workspaceId) return;
    const title = directoryTitle.trim();
    if (!title) {
      toast.error("Folder name is required.");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await contentClient.createSource(workspaceId, {
        sourceType: "directory",
        parentSourceId: directoryParentSourceId,
        title,
        contentText: directoryContext.trim() || undefined,
      });
      if (directoryContext.trim()) {
        await contentClient.indexSource(workspaceId, created.source.id, {});
        setPendingSourceIds((prev) =>
          prev.includes(created.source.id)
            ? prev
            : [...prev, created.source.id],
        );
      }
      selectNewSourceIds([created.source.id]);
      toast.success("Folder created.");
      setIsCreateDirectoryOpen(false);
      setDirectoryTitle("");
      setDirectoryContext("");
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create folder."));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    workspaceId,
    directoryTitle,
    directoryContext,
    directoryParentSourceId,
    refreshSources,
    selectNewSourceIds,
  ]);

  const handleUpdateReadme = useCallback(async () => {
    if (!workspaceId || !readmeSource) return;

    setIsSubmitting(true);
    setRowBusy(readmeSource.id, true);
    try {
      await contentClient.updateSource(workspaceId, readmeSource.id, {
        contentText: readmeContent,
      });
      toast.success("README updated.");
      setReadmeSource(null);
      setReadmeContent("");
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to update README."));
    } finally {
      setIsSubmitting(false);
      setRowBusy(readmeSource.id, false);
    }
  }, [workspaceId, readmeSource, readmeContent, refreshSources]);

  const handleOpenMoveDialog = useCallback((source: SourceItem) => {
    setMoveSource(source);
    setMoveParentSourceId(source.parentSourceId);
  }, []);

  const handleMoveSource = useCallback(async () => {
    if (!workspaceId || !moveSource) return;
    setRowBusy(moveSource.id, true);
    setIsSubmitting(true);
    try {
      await contentClient.updateSource(workspaceId, moveSource.id, {
        parentSourceId: moveParentSourceId,
      });
      toast.success("Source moved.");
      setMoveSource(null);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to move source."));
    } finally {
      setIsSubmitting(false);
      setRowBusy(moveSource.id, false);
    }
  }, [workspaceId, moveSource, moveParentSourceId, refreshSources]);

  const handleDownloadSource = useCallback(
    async (source: SourceItem) => {
      if (!workspaceId) return;
      if (!source.storageKey) {
        toast.error("This source has no original uploaded file.");
        return;
      }

      const link = document.createElement("a");
      link.href = `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(source.id)}/download`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    },
    [workspaceId],
  );

  const handleCreateTextSource = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }

    const contentText = addSourceDialog.textContent.trim();
    if (!contentText) {
      toast.error("Source content cannot be empty.");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await contentClient.createSource(workspaceId, {
        title: addSourceDialog.textTitle.trim() || undefined,
        contentText,
        parentSourceId: addSourceDialog.parentSourceId,
      });

      await contentClient.indexSource(workspaceId, created.source.id, {});
      setPendingSourceIds((prev) =>
        prev.includes(created.source.id) ? prev : [...prev, created.source.id],
      );
      selectNewSourceIds([created.source.id]);

      toast.success("Source added and indexing started.");
      addSourceDialog.close(false);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create source."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, addSourceDialog, refreshSources, selectNewSourceIds]);

  const handleCreateUrlSource = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }

    const url = addSourceDialog.urlValue.trim();
    if (!url) {
      toast.error("URL cannot be empty.");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await contentClient.createUrlSource(workspaceId, {
        url,
        title: addSourceDialog.urlTitle.trim() || undefined,
        parentSourceId: addSourceDialog.parentSourceId,
      });

      setPendingSourceIds((prev) =>
        prev.includes(created.source.id) ? prev : [...prev, created.source.id],
      );
      selectNewSourceIds([created.source.id]);

      toast.success("URL source added. Processing started.");
      addSourceDialog.close(false);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to add URL source."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, addSourceDialog, refreshSources, selectNewSourceIds]);

  const handleUploadFiles = useCallback(async () => {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }
    if (addSourceDialog.files.length === 0) {
      toast.error("Select files to upload first.");
      return;
    }

    setIsSubmitting(true);
    addSourceDialog.setUploadProgress(0);
    const createdSourceIds: string[] = [];
    const total = addSourceDialog.files.length;
    let processed = 0;

    try {
      for (const file of addSourceDialog.files) {
        const result = await contentClient.uploadSource(workspaceId, file, {
          parentSourceId: addSourceDialog.parentSourceId,
        });
        createdSourceIds.push(result.source.id);
        processed += 1;
        addSourceDialog.setUploadProgress(
          Math.round((processed / total) * 100),
        );
      }

      if (createdSourceIds.length > 0) {
        setPendingSourceIds((prev) =>
          Array.from(new Set([...prev, ...createdSourceIds])),
        );
        selectNewSourceIds(createdSourceIds);
      }

      toast.success(
        createdSourceIds.length === 1
          ? "1 source uploaded. Processing started."
          : `${createdSourceIds.length} sources uploaded. Processing started.`,
      );
      addSourceDialog.close(false);
      await refreshSources();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to upload files."));
    } finally {
      setIsSubmitting(false);
    }
  }, [workspaceId, addSourceDialog, refreshSources, selectNewSourceIds]);

  return {
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
  };
}
