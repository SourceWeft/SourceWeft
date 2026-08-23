import { useCallback, useEffect, useRef, useState } from "react";

import { contentClient } from "../../../../../../lib/sdk";
import { cloneItems } from "../cache";
import { getErrorMessage } from "../lib/errors";
import type { ArtifactSummaryItem } from "../types";
import {
  getCachedWorkspaceHubValue,
  setCachedWorkspaceHubValue,
} from "../workspace-hub-cache";
import { subscribeArtifactDeleted } from "./artifact-delete-events";
import { invalidateArtifactDetail } from "./artifact-detail-loader";

const workspaceArtifactsCache = new Map<string, ArtifactSummaryItem[]>();
const workspaceArtifactsCursorCache = new Map<string, string | null>();
const WORKSPACE_ARTIFACTS_CACHE_BUCKET = "artifact-summaries-v1";

type WorkspaceArtifactsCacheValue = {
  items: ArtifactSummaryItem[];
  nextCursor: string | null;
};

function cloneArtifactItems(items: ArtifactSummaryItem[]) {
  return cloneItems(items);
}

export function useArtifacts(input: {
  workspaceId: string | null | undefined;
  artifactsRefreshKey: number;
  currentWorkspaceIdRef: { current: string | null | undefined };
  enabled: boolean;
}) {
  const {
    workspaceId,
    artifactsRefreshKey,
    currentWorkspaceIdRef,
    enabled,
  } = input;

  const [artifacts, setArtifacts] = useState<ArtifactSummaryItem[]>([]);
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const [isLoadingMoreArtifacts, setIsLoadingMoreArtifacts] = useState(false);
  const [artifactsLoadingError, setArtifactsLoadingError] = useState<
    string | null
  >(null);
  const [artifactsNextCursor, setArtifactsNextCursor] = useState<string | null>(
    null,
  );

  const refreshArtifacts = useCallback(async () => {
    if (!workspaceId || !enabled) {
      setArtifacts([]);
      setArtifactsLoadingError(null);
      setArtifactsNextCursor(null);
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingArtifacts(true);
    setArtifactsLoadingError(null);
    try {
      const result = await contentClient.listArtifactSummaries(activeWorkspaceId, {
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
  }, [currentWorkspaceIdRef, enabled, workspaceId]);

  const loadMoreArtifacts = useCallback(async () => {
    if (
      !workspaceId ||
      !enabled ||
      !artifactsNextCursor ||
      isLoadingMoreArtifacts
    ) {
      return;
    }

    const activeWorkspaceId = workspaceId;
    setIsLoadingMoreArtifacts(true);
    setArtifactsLoadingError(null);
    try {
      const result = await contentClient.listArtifactSummaries(activeWorkspaceId, {
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
    enabled,
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
      if (enabled) {
        void refreshArtifacts();
      }
      return;
    }

    if (enabled) {
      void refreshArtifacts();
    }
  }, [enabled, refreshArtifacts, workspaceId]);

  const lastRefreshKeyRef = useRef(artifactsRefreshKey);
  useEffect(() => {
    const changed = lastRefreshKeyRef.current !== artifactsRefreshKey;
    lastRefreshKeyRef.current = artifactsRefreshKey;
    if (changed && enabled) {
      void refreshArtifacts();
    }
  }, [artifactsRefreshKey, enabled, refreshArtifacts]);

  // Evict a deleted artifact from the list and both cache layers the moment
  // the preview panel deletes it, without waiting for the next full refresh.
  useEffect(() => {
    return subscribeArtifactDeleted(
      ({ workspaceId: deletedIn, artifactId }) => {
        invalidateArtifactDetail(deletedIn, artifactId);
        const removeDeleted = (items: ArtifactSummaryItem[]) =>
          items.filter((artifact) => artifact.id !== artifactId);

        const cachedItems = workspaceArtifactsCache.get(deletedIn);
        if (cachedItems) {
          const remaining = removeDeleted(cachedItems);
          workspaceArtifactsCache.set(deletedIn, remaining);
          setCachedWorkspaceHubValue<WorkspaceArtifactsCacheValue>(
            WORKSPACE_ARTIFACTS_CACHE_BUCKET,
            deletedIn,
            {
              items: remaining,
              nextCursor: workspaceArtifactsCursorCache.get(deletedIn) ?? null,
            },
          );
        }
        if (workspaceId === deletedIn) {
          setArtifacts(removeDeleted);
        }
      },
    );
  }, [workspaceId]);

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
