import { useCallback, useEffect, useRef, useState } from "react";

import type { McpToolSelection, WorkspaceMcpInstall } from "@sourceweft/sdk";
import { contentClient } from "../../../../../../lib/sdk";
import { getErrorMessage } from "../lib/errors";
import {
  getCachedWorkspaceHubValue,
  setCachedWorkspaceHubValue,
} from "../workspace-hub-cache";

const WORKSPACE_MCP_CACHE_BUCKET = "mcp";

type WorkspaceMcpCacheValue = {
  installs: WorkspaceMcpInstall[];
};

export function useMcp(input: {
  workspaceId: string | null | undefined;
  selectedMcpInstallIds: string[];
  selectedMcpToolIds: string[];
  onMcpSelectionChange: (selection: McpToolSelection) => void;
  currentWorkspaceIdRef: { current: string | null | undefined };
}) {
  const {
    workspaceId,
    selectedMcpInstallIds,
    selectedMcpToolIds,
    onMcpSelectionChange,
    currentWorkspaceIdRef,
  } = input;

  const [mcpInstalls, setMcpInstalls] = useState<WorkspaceMcpInstall[]>([]);
  const [isLoadingMcp, setIsLoadingMcp] = useState(false);
  const [mcpLoadingError, setMcpLoadingError] = useState<string | null>(null);

  // The current selection + change callback are read through refs so
  // refreshMcpInstalls keeps a stable identity. Otherwise an unstable
  // onMcpSelectionChange / selection array from the caller would change the
  // callback every render, re-run the cache-load effect every render, and its
  // isLoading toggle would drive an infinite render loop. Pruning always runs
  // against the latest selection, and installs are only re-fetched on workspace
  // change (not on every selection tweak).
  const selectedMcpInstallIdsRef = useRef(selectedMcpInstallIds);
  selectedMcpInstallIdsRef.current = selectedMcpInstallIds;
  const selectedMcpToolIdsRef = useRef(selectedMcpToolIds);
  selectedMcpToolIdsRef.current = selectedMcpToolIds;
  const onMcpSelectionChangeRef = useRef(onMcpSelectionChange);
  onMcpSelectionChangeRef.current = onMcpSelectionChange;

  const refreshMcpInstalls = useCallback(async () => {
    if (!workspaceId) {
      setMcpInstalls([]);
      setMcpLoadingError(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingMcp(true);
    setMcpLoadingError(null);
    try {
      const result =
        await contentClient.listWorkspaceMcpInstalls(activeWorkspaceId);
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }
      setMcpInstalls(result.items);
      setCachedWorkspaceHubValue<WorkspaceMcpCacheValue>(
        WORKSPACE_MCP_CACHE_BUCKET,
        activeWorkspaceId,
        { installs: result.items },
      );
      const installIds = new Set(result.items.map((install) => install.id));
      const toolIds = new Set(
        result.items.flatMap((install) => install.tools.map((tool) => tool.id)),
      );
      const currentInstallIds = selectedMcpInstallIdsRef.current;
      const currentToolIds = selectedMcpToolIdsRef.current;
      const nextInstallIds = currentInstallIds.filter((id) =>
        installIds.has(id),
      );
      const nextToolIds = currentToolIds.filter((id) => toolIds.has(id));
      if (
        nextInstallIds.length !== currentInstallIds.length ||
        nextToolIds.length !== currentToolIds.length
      ) {
        onMcpSelectionChangeRef.current({
          enabled: nextInstallIds.length > 0 || nextToolIds.length > 0,
          installIds: nextInstallIds,
          toolIds: nextToolIds,
        });
      }
    } catch (error) {
      setMcpLoadingError(getErrorMessage(error, "Failed to load MCP tools."));
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingMcp(false);
      }
    }
  }, [currentWorkspaceIdRef, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      void refreshMcpInstalls();
      return;
    }

    const cached = getCachedWorkspaceHubValue<WorkspaceMcpCacheValue>(
      WORKSPACE_MCP_CACHE_BUCKET,
      workspaceId,
    );
    if (cached) {
      setMcpInstalls(cached.installs);
      setMcpLoadingError(null);
      setIsLoadingMcp(false);
    }
    void refreshMcpInstalls();
  }, [refreshMcpInstalls, workspaceId]);

  return {
    mcpInstalls,
    isLoadingMcp,
    mcpLoadingError,
    refreshMcpInstalls,
  };
}
