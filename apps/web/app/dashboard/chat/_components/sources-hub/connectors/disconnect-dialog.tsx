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
import { cn } from "@sourceweft/ui-web/lib/utils";

import { getConnectorDisplayName } from "./components";
import type { ConnectorItem } from "./types";

export function ConnectorDisconnectDialog({
  connector,
  hardDelete,
  isBusy,
  onConfirm,
  onHardDeleteChange,
  onOpenChange,
}: {
  connector: ConnectorItem | null;
  hardDelete: boolean;
  isBusy: boolean;
  onConfirm: () => void;
  onHardDeleteChange: (hardDelete: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={Boolean(connector)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Manage connector removal</AlertDialogTitle>
          <AlertDialogDescription>
            Choose whether to temporarily disable this connector or permanently
            delete it from SourceWeft.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {connector ? (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
            <span className="line-clamp-2 break-words">
              {getConnectorDisplayName(connector)}
            </span>
          </div>
        ) : null}
        <div className="space-y-2">
          <button
            className={cn(
              "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
              !hardDelete
                ? "border-primary bg-primary/5"
                : "hover:bg-accent/60",
            )}
            onClick={() => onHardDeleteChange(false)}
            type="button"
          >
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                !hardDelete && "border-primary bg-primary",
              )}
            >
              {!hardDelete ? (
                <span className="size-1.5 rounded-full bg-primary-foreground" />
              ) : null}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                Disable connector
              </span>
              <span className="block text-xs text-muted-foreground">
                Stops syncing. Keeps authorization, configuration, history, and
                indexed content. You can enable it again later.
              </span>
            </span>
          </button>
          <button
            className={cn(
              "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
              hardDelete
                ? "border-destructive bg-destructive/5"
                : "hover:bg-accent/60",
            )}
            onClick={() => onHardDeleteChange(true)}
            type="button"
          >
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                hardDelete && "border-destructive bg-destructive",
              )}
            >
              {hardDelete ? (
                <span className="size-1.5 rounded-full bg-destructive-foreground" />
              ) : null}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-destructive">
                Delete connector and all indexed content
              </span>
              <span className="block text-xs text-muted-foreground">
                Permanently deletes this connector, its local authorization, and
                all content imported by it. This cannot be undone.
              </span>
            </span>
          </button>
          <p className="text-xs text-muted-foreground">
            SourceWeft will not revoke access in the third-party provider.
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              hardDelete && buttonVariants({ variant: "destructive" }),
              "whitespace-normal text-center",
            )}
            disabled={isBusy}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {isBusy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {hardDelete ? "Deleting..." : "Disabling..."}
              </>
            ) : hardDelete ? (
              "Delete connector and content"
            ) : (
              "Disable connector"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
