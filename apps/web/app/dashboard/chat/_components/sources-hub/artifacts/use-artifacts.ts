import { useCallback, useEffect, useState } from "react";

import { contentClient } from "../../../../../../lib/sdk";
import { cloneItems } from "../cache";
import { getErrorMessage } from "../lib/errors";
import type { ArtifactListItem } from "../types";
import {
  getCachedWorkspaceHubValue,
  setCachedWorkspaceHubValue,
} from "../workspace-hub-cache";

const workspaceArtifactsCache = new Map<string, ArtifactListItem[]>();
const workspaceArtifactsCursorCache = new Map<string, string | null>();
const WORKSPACE_ARTIFACTS_CACHE_BUCKET = "artifacts";

type WorkspaceArtifactsCacheValue = {
  items: ArtifactListItem[];
  nextCursor: string | null;
};

function cloneArtifactItems(items: ArtifactListItem[]) {
  return cloneItems(items);
}

export function useArtifacts(input: {
  workspaceId: string | null | undefined;
  artifactsRefreshKey: number;
  currentWorkspaceIdRef: { current: string | null | undefined };
}) {
  const { workspaceId, artifactsRefreshKey, currentWorkspaceIdRef } = input;

  const [artifacts, setArtifacts] = useState<ArtifactListItem[]>([]);
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const [isLoadingMoreArtifacts, setIsLoadingMoreArtifacts] = useState(false);
  const [artifactsLoadingError, setArtifactsLoadingError] = useState<
    string | null
  >(null);
  const [artifactsNextCursor, setArtifactsNextCursor] = useState<string | null>(
    null,
  );

  const refreshArtifacts = useCallback(async () => {
    if (!workspaceId) {
      setArtifacts([]);
      setArtifactsLoadingError(null);
      setArtifactsNextCursor(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingArtifacts(true);
    setArtifactsLoadingError(null);
    try {
      const result = await contentClient.listArtifacts(activeWorkspaceId, {
        limit: 100,
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      setArtifacts(result.items);
      setArtifactsNextCursor(result.nextCursor ?? null);
      workspaceArtifactsCache.set(
        activeWorkspaceId,
        cloneArtifactItems(result.items),
      );
      workspaceArtifactsCursorCache.set(
        activeWorkspaceId,
        result.nextCursor ?? null,
      );
      setCachedWorkspaceHubValue<WorkspaceArtifactsCacheValue>(
        WORKSPACE_ARTIFACTS_CACHE_BUCKET,
        activeWorkspaceId,
        {
          items: result.items,
          nextCursor: result.nextCursor ?? null,
        },
      );
    } catch (error) {
      setArtifactsLoadingError(
        getErrorMessage(error, "Failed to load artifacts."),
      );
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingArtifacts(false);
      }
    }
  }, [currentWorkspaceIdRef, workspaceId]);

  const loadMoreArtifacts = useCallback(async () => {
    if (!workspaceId || !artifactsNextCursor || isLoadingMoreArtifacts) {
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingMoreArtifacts(true);
    setArtifactsLoadingError(null);
    try {
      const result = await contentClient.listArtifacts(activeWorkspaceId, {
        cursor: artifactsNextCursor,
        limit: 100,
      });
      if (currentWorkspaceIdRef.current !== activeWorkspaceId) {
        return;
      }

      setArtifacts((current) => {
        const mergedById = new Map(
          current.map((artifact) => [artifact.id, artifact]),
        );
        for (const artifact of result.items) {
          mergedById.set(artifact.id, artifact);
        }
        const merged = Array.from(mergedById.values());
        workspaceArtifactsCache.set(
          activeWorkspaceId,
          cloneArtifactItems(merged),
        );
        setCachedWorkspaceHubValue<WorkspaceArtifactsCacheValue>(
          WORKSPACE_ARTIFACTS_CACHE_BUCKET,
          activeWorkspaceId,
          {
            items: merged,
            nextCursor: result.nextCursor ?? null,
          },
        );
        return merged;
      });
      setArtifactsNextCursor(result.nextCursor ?? null);
      workspaceArtifactsCursorCache.set(
        activeWorkspaceId,
        result.nextCursor ?? null,
      );
    } catch (error) {
      setArtifactsLoadingError(
        getErrorMessage(error, "Failed to load more artifacts."),
      );
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingMoreArtifacts(false);
      }
    }
  }, [
    artifactsNextCursor,
    currentWorkspaceIdRef,
    isLoadingMoreArtifacts,
    workspaceId,
  ]);

  useEffect(() => {
    if (!workspaceId) {
      setArtifacts([]);
      setArtifactsLoadingError(null);
      setArtifactsNextCursor(null);
      setIsLoadingMoreArtifacts(false);
      return;
    }

    const inMemoryCached = workspaceArtifactsCache.has(workspaceId)
      ? {
          items: workspaceArtifactsCache.get(workspaceId) ?? [],
          nextCursor: workspaceArtifactsCursorCache.get(workspaceId) ?? null,
        }
      : null;
    const cached =
      inMemoryCached ??
      getCachedWorkspaceHubValue<WorkspaceArtifactsCacheValue>(
        WORKSPACE_ARTIFACTS_CACHE_BUCKET,
        workspaceId,
      );
    if (cached) {
      workspaceArtifactsCache.set(
        workspaceId,
        cloneArtifactItems(cached.items),
      );
      workspaceArtifactsCursorCache.set(workspaceId, cached.nextCursor);
      setArtifacts(cloneArtifactItems(cached.items));
      setArtifactsNextCursor(cached.nextCursor);
      setArtifactsLoadingError(null);
      setIsLoadingArtifacts(false);
      setIsLoadingMoreArtifacts(false);
      void refreshArtifacts();
      return;
    }

    void refreshArtifacts();
  }, [refreshArtifacts, workspaceId]);

  useEffect(() => {
    if (artifactsRefreshKey > 0) {
      void refreshArtifacts();
    }
  }, [artifactsRefreshKey, refreshArtifacts]);

  return {
    artifacts,
    isLoadingArtifacts,
    isLoadingMoreArtifacts,
    artifactsLoadingError,
    artifactsNextCursor,
    refreshArtifacts,
    loadMoreArtifacts,
  };
}
