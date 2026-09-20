import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

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
  const t = useTranslations("dashboardSourcesHub");
  return (
    <AlertDialog onOpenChange={onOpenChange} open={Boolean(connector)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("connectors.disconnectTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("connectors.disconnectDescription")}
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
                {t("connectors.disableOption")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("connectors.disableOptionDesc")}
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
                {t("connectors.deleteOption")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("connectors.deleteOptionDesc")}
              </span>
            </span>
          </button>
          <p className="text-xs text-muted-foreground">
            {t("connectors.disconnectNote")}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isBusy}>
            {t("common.cancel")}
          </AlertDialogCancel>
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
                {hardDelete
                  ? t("connectors.deleting")
                  : t("connectors.disabling")}
              </>
            ) : hardDelete ? (
              t("connectors.deleteConfirm")
            ) : (
              t("connectors.disableConfirm")
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
