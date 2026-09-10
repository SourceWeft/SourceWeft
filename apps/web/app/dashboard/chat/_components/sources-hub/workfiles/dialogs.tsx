import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { contentClient } from "../../../../../../lib/sdk";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sourceweft/ui-web/components/ui/alert-dialog";
import { buttonVariants } from "@sourceweft/ui-web/components/ui/button";
import { FilePreviewDialog } from "../../file-preview-dialog";
import { formatBytes } from "../lib/format";
import {
  workfilePurposeLabel,
  type WorkfileDetail,
  type WorkfileListItem,
} from "./use-workfiles";

export function WorkfilePreviewDialog({
  onOpenChange,
  previewWorkfile,
}: {
  onOpenChange: (open: boolean) => void;
  previewWorkfile: WorkfileDetail | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    blob?: Blob;
    error?: string;
  } | null>(null);
  const key = previewWorkfile
    ? `${previewWorkfile.workspaceId}:${previewWorkfile.threadId}:${previewWorkfile.path}:${previewWorkfile.contentHash}`
    : "";
  const binary = previewWorkfile?.payloadKind === "object";
  useEffect(() => {
    if (!previewWorkfile || !binary) return;
    const controller = new AbortController();
    setState({ key });
    void contentClient
      .readFileBlob(
        previewWorkfile.workspaceId,
        previewWorkfile.threadId,
        previewWorkfile.path,
        controller.signal,
      )
      .then((blob) => {
        if (!controller.signal.aborted) setState({ key, blob });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            error:
              error instanceof Error ? error.message : "Could not read file.",
          });
      });
    return () => controller.abort();
  }, [key, binary, attempt, previewWorkfile]);
  const current = state?.key === key ? state : null;
  const source = useMemo(
    () =>
      previewWorkfile && current?.blob
        ? {
            name: previewWorkfile.path.split("/").pop()!,
            mimeType: previewWorkfile.mimeType,
            blob: current.blob,
          }
        : undefined,
    [previewWorkfile, current?.blob],
  );
  return (
    <FilePreviewDialog
      onOpenChange={onOpenChange}
      open={Boolean(previewWorkfile)}
      path={previewWorkfile?.path ?? ""}
      description={
        previewWorkfile
          ? `Cloud · ${previewWorkfile.path} · ${formatBytes(previewWorkfile.sizeBytes)} · ${workfilePurposeLabel(previewWorkfile.purpose)}`
          : "Files in this conversation."
      }
      contentText={binary ? undefined : previewWorkfile?.contentText}
      source={source}
      loading={Boolean(binary && !current?.blob && !current?.error)}
      error={current?.error}
      onRetry={binary ? () => setAttempt((value) => value + 1) : undefined}
      mimeType={previewWorkfile?.mimeType}
    />
  );
}

export function DeleteWorkfileDialog({
  deleteWorkfile,
  onConfirm,
  onOpenChange,
  workfileBusyByPath,
}: {
  deleteWorkfile: WorkfileListItem | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  workfileBusyByPath: Record<string, boolean>;
}) {
  const isDeleting = Boolean(
    deleteWorkfile && workfileBusyByPath[deleteWorkfile.path],
  );

  return (
    <AlertDialog onOpenChange={onOpenChange} open={Boolean(deleteWorkfile)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete file?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the file from this conversation. This action cannot
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteWorkfile ? (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
            <span className="line-clamp-2 break-words">
              {deleteWorkfile.path}
            </span>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={isDeleting}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {isDeleting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
