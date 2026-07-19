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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { WorkfileContentViewer } from "../../workfile-content-viewer";
import { basename, formatBytes } from "../lib/format";
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
    <Dialog onOpenChange={onOpenChange} open={Boolean(previewWorkfile)}>
      <DialogContent
        className="grid max-h-[min(720px,calc(100svh-2rem))] w-[760px] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle>
            {previewWorkfile ? basename(previewWorkfile.path) : "Workfile"}
          </DialogTitle>
          <DialogDescription>
            {previewWorkfile
              ? `${previewWorkfile.path} · ${formatBytes(previewWorkfile.sizeBytes)} · ${workfilePurposeLabel(previewWorkfile.purpose)}`
              : "Assistant-created working material from this thread."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-5">
          {previewWorkfile ? (
            <WorkfileContentViewer
              className="h-full min-h-[360px]"
              contentText={previewWorkfile.contentText}
              mimeType={previewWorkfile.mimeType}
              path={previewWorkfile.path}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
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
