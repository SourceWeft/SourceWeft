import { Loader2 } from "lucide-react";

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
  return (
    <FilePreviewDialog
      onOpenChange={onOpenChange}
      open={Boolean(previewWorkfile)}
      path={previewWorkfile?.path ?? ""}
      description={
        previewWorkfile
          ? `Cloud · ${previewWorkfile.path} · ${formatBytes(previewWorkfile.sizeBytes)} · ${workfilePurposeLabel(previewWorkfile.purpose)}`
          : "Assistant-created working material from this thread."
      }
      contentText={previewWorkfile?.contentText}
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
          <AlertDialogTitle>Delete workfile?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the Workfile from this thread. This action cannot
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
