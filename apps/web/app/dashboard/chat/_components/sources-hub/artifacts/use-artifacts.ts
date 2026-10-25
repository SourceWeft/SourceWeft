import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { contentClient } from "../../../../../../lib/sdk";
import { cloneItems } from "../cache";
import { getErrorMessage } from "../lib/errors";
import type { ArtifactSummaryItem } from "../types";
import {
  getCachedWorkspaceHubValue,
  setCachedWorkspaceHubValue,
} from "../workspace-hub-cache";
import { subscribeArtifactApprovalChanged } from "./artifact-approval-events";
import { subscribeArtifactDeleted } from "./artifact-delete-events";
import { invalidateArtifactDetail } from "./artifact-detail-loader";

const workspaceArtifactsCache = new Map<string, ArtifactSummaryItem[]>();
const workspaceArtifactsCursorCache = new Map<string, string | null>();
const workspaceArtifactsRefreshInFlight = new Map<
  string,
  ReturnType<typeof contentClient.listArtifactSummaries>
>();
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
  const { workspaceId, artifactsRefreshKey, currentWorkspaceIdRef, enabled } =
    input;

  const t = useTranslations("dashboardSourcesHub");
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
      let request = workspaceArtifactsRefreshInFlight.get(activeWorkspaceId);
      if (!request) {
        request = contentClient
          .listArtifactSummaries(activeWorkspaceId, { limit: 100 })
          .finally(() => {
            if (
              workspaceArtifactsRefreshInFlight.get(activeWorkspaceId) ===
              request
            ) {
              workspaceArtifactsRefreshInFlight.delete(activeWorkspaceId);
            }
          });
        workspaceArtifactsRefreshInFlight.set(activeWorkspaceId, request);
      }
      const result = await request;
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
        getErrorMessage(error, t("artifacts.loadFailed")),
      );
    } finally {
      if (currentWorkspaceIdRef.current === activeWorkspaceId) {
        setIsLoadingArtifacts(false);
      }
    }
  }, [currentWorkspaceIdRef, enabled, workspaceId, t]);

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
      const result = await contentClient.listArtifactSummaries(
        activeWorkspaceId,
        {
          cursor: artifactsNextCursor,
          limit: 100,
        },
      );
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
        getErrorMessage(error, t("artifacts.loadMoreFailed")),
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
    t,
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

  // Approving or revoking shared data in the preview changes the marker. Re-read
  // the first page and copy only that flag onto the rows already shown, so the
  // list does not flash a loading state and loaded pages stay as they are.
  // Whether the marker flips depends on whether the touched version is the
  // current one, which only the server knows.
  useEffect(() => {
    return subscribeArtifactApprovalChanged(
      async ({ workspaceId: changedIn }) => {
        try {
          const fresh = await contentClient.listArtifactSummaries(changedIn, {
            limit: 100,
          });
          const flags = new Map(
            fresh.items.map((item) => [item.id, item.awaitingSharedApproval]),
          );
          const patch = (items: ArtifactSummaryItem[]) =>
            items.map((item) => {
              const flag = flags.get(item.id);
              return flag === undefined || flag === item.awaitingSharedApproval
                ? item
                : { ...item, awaitingSharedApproval: flag };
            });
          const cachedItems = workspaceArtifactsCache.get(changedIn);
          if (cachedItems) {
            const patched = patch(cachedItems);
            workspaceArtifactsCache.set(changedIn, patched);
            setCachedWorkspaceHubValue<WorkspaceArtifactsCacheValue>(
              WORKSPACE_ARTIFACTS_CACHE_BUCKET,
              changedIn,
              {
                items: patched,
                nextCursor:
                  workspaceArtifactsCursorCache.get(changedIn) ?? null,
              },
            );
          }
          if (currentWorkspaceIdRef.current === changedIn) {
            setArtifacts(patch);
          }
        } catch {
          // The marker is advisory; the next list refresh corrects it.
        }
      },
    );
  }, [currentWorkspaceIdRef]);

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
