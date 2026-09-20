import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { contentClient } from "../../../../../../lib/sdk";
import { cloneItems, getThreadWorkfilesCacheKey } from "../cache";
import { getErrorMessage } from "../lib/errors";
import { basename } from "../lib/format";

export type WorkfileListItem = Awaited<
  ReturnType<typeof contentClient.listWorkingFiles>
>["items"][number];
export type WorkfileDetail = Awaited<
  ReturnType<typeof contentClient.getWorkingFile>
>["file"];

const threadWorkfilesCache = new Map<string, WorkfileListItem[]>();

function cloneWorkfileItems(items: WorkfileListItem[]) {
  return cloneItems(items);
}

export function workfilePurposeLabel(purpose: WorkfileListItem["purpose"]) {
  if (purpose === "scratch") return "Scratch";
  if (purpose === "draft") return "Draft";
  if (purpose === "note") return "Note";
  if (purpose === "output_candidate") return "Candidate";
  return "File";
}

/**
 * Stable i18n key suffix for a workfile purpose. UI renders the label via
 * `t("files.purpose.<key>")`; the English `workfilePurposeLabel` above remains
 * the search-matching vocabulary.
 */
export function workfilePurposeKey(purpose: WorkfileListItem["purpose"]) {
  if (
    purpose === "scratch" ||
    purpose === "draft" ||
    purpose === "note" ||
    purpose === "output_candidate"
  ) {
    return purpose;
  }
  return "file";
}

export function workfileMatchesQuery(file: WorkfileListItem, q: string) {
  return (
    file.path.toLowerCase().includes(q) ||
    basename(file.path).toLowerCase().includes(q) ||
    file.mimeType.toLowerCase().includes(q) ||
    workfilePurposeLabel(file.purpose).toLowerCase().includes(q)
  );
}

export function useWorkfiles(input: {
  mode: "thread" | "new";
  enabled?: boolean;
  workspaceId: string | null | undefined;
  threadId: string | null;
  workfilesRefreshKey: number;
  currentWorkspaceIdRef: { current: string | null | undefined };
}) {
  const {
    mode,
    enabled = true,
    workspaceId,
    threadId,
    workfilesRefreshKey,
    currentWorkspaceIdRef,
  } = input;

  const t = useTranslations("dashboardSourcesHub");
  const liveScope = useRef("");
  liveScope.current = `${enabled}:${workspaceId}:${threadId}:${mode}`;
  const [workfiles, setWorkfiles] = useState<WorkfileListItem[]>([]);
  const [isLoadingWorkfiles, setIsLoadingWorkfiles] = useState(false);
  const [workfilesLoadingError, setWorkfilesLoadingError] = useState<
    string | null
  >(null);
  const [previewWorkfile, setPreviewWorkfile] = useState<WorkfileDetail | null>(
    null,
  );
  const [deleteWorkfile, setDeleteWorkfile] = useState<WorkfileListItem | null>(
    null,
  );
  const [workfileBusyByPath, setWorkfileBusyByPath] = useState<
    Record<string, boolean>
  >({});

  const setWorkfileBusy = useCallback((path: string, busy: boolean) => {
    setWorkfileBusyByPath((prev) => {
      if (busy) return { ...prev, [path]: true };
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  const refreshWorkfiles = useCallback(async () => {
    if (!enabled || !workspaceId || !threadId || mode !== "thread") {
      setWorkfiles([]);
      setIsLoadingWorkfiles(false);
      setWorkfilesLoadingError(null);
      return;
    }

    const requestScope = liveScope.current;
    const activeWorkspaceId = workspaceId;
    const activeThreadId = threadId;
    setIsLoadingWorkfiles(true);
    setWorkfilesLoadingError(null);
    try {
      const result = await contentClient.listWorkingFiles(
        activeWorkspaceId,
        activeThreadId,
      );
      // Guard against a workspace switch in flight, matching refreshArtifacts /
      // refreshMcpInstalls; without this, a stale workspace's workfiles could be
      // written into the current view.
      if (
        liveScope.current !== requestScope ||
        currentWorkspaceIdRef.current !== activeWorkspaceId
      ) {
        return;
      }
      setWorkfiles(result.items);
      threadWorkfilesCache.set(
        getThreadWorkfilesCacheKey(activeWorkspaceId, activeThreadId),
        cloneWorkfileItems(result.items),
      );
    } catch (error) {
      if (liveScope.current !== requestScope) return;
      setWorkfilesLoadingError(
        getErrorMessage(error, t("toasts.workfiles.loadFailed")),
      );
    } finally {
      if (
        liveScope.current === requestScope &&
        currentWorkspaceIdRef.current === activeWorkspaceId
      ) {
        setIsLoadingWorkfiles(false);
      }
    }
  }, [currentWorkspaceIdRef, enabled, mode, threadId, workspaceId, t]);

  useEffect(() => {
    if (!enabled || !workspaceId || !threadId || mode !== "thread") {
      setWorkfiles([]);
      setIsLoadingWorkfiles(false);
      setWorkfilesLoadingError(null);
      return;
    }

    const cached = threadWorkfilesCache.get(
      getThreadWorkfilesCacheKey(workspaceId, threadId),
    );
    if (cached) {
      setWorkfiles(cloneWorkfileItems(cached));
      setWorkfilesLoadingError(null);
      setIsLoadingWorkfiles(false);
      return;
    }

    void refreshWorkfiles();
  }, [enabled, mode, refreshWorkfiles, threadId, workspaceId]);

  useEffect(() => {
    if (workfilesRefreshKey > 0) {
      void refreshWorkfiles();
    }
  }, [refreshWorkfiles, workfilesRefreshKey]);

  const handleOpenWorkfile = useCallback(
    async (file: WorkfileListItem) => {
      if (!workspaceId || !threadId) return;

      setWorkfileBusy(file.path, true);
      try {
        const result = await contentClient.getWorkingFile(
          workspaceId,
          threadId,
          file.path,
        );
        setPreviewWorkfile(result.file);
      } catch (error) {
        toast.error(getErrorMessage(error, t("files.readError")));
      } finally {
        setWorkfileBusy(file.path, false);
      }
    },
    [setWorkfileBusy, threadId, workspaceId, t],
  );

  const handleConfirmDeleteWorkfile = useCallback(async () => {
    if (!workspaceId || !threadId || !deleteWorkfile) return;

    setWorkfileBusy(deleteWorkfile.path, true);
    try {
      await contentClient.deleteWorkingFile(
        workspaceId,
        threadId,
        deleteWorkfile.path,
      );
      toast.success(t("toasts.workfiles.fileDeleted"));
      setDeleteWorkfile(null);
      if (previewWorkfile?.path === deleteWorkfile.path) {
        setPreviewWorkfile(null);
      }
      await refreshWorkfiles();
    } catch (error) {
      toast.error(getErrorMessage(error, t("toasts.workfiles.deleteFailed")));
    } finally {
      setWorkfileBusy(deleteWorkfile.path, false);
    }
  }, [
    deleteWorkfile,
    previewWorkfile?.path,
    refreshWorkfiles,
    setWorkfileBusy,
    threadId,
    workspaceId,
    t,
  ]);

  return {
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
  };
}
