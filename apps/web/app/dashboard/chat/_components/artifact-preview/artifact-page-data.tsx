"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Database, Download, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ArtifactRecordScope } from "@sourceweft/contracts/artifact-records";
import { htmlArtifactRecordCapabilities } from "@sourceweft/contracts/html-artifact";
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
import {
  Button,
  buttonVariants,
} from "@sourceweft/ui-web/components/ui/button";
import { contentClient } from "../../../../../lib/sdk";
import { getErrorMessage } from "../sources-hub/lib/errors";
import type { ArtifactListItem } from "../sources-hub/types";

/** A file name that is safe on every platform, whatever the title holds. */
export function pageDataFileName(title: string, scope: ArtifactRecordScope) {
  const base = title
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 60);
  return `${base || "artifact"}-${scope}-data.json`;
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the browser has had the chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Export and clear for the JSON records an HTML page keeps. Rendered only for
 * HTML artifacts whose payload declares storage; the shell stays unaware of
 * the feature. The server owns every permission rule (shared data is for the
 * artifact's creator or a workspace admin), so a refusal arrives as a toast.
 */
export function ArtifactPageData({
  artifact,
  title,
  workspaceId,
}: {
  artifact: ArtifactListItem;
  title: string;
  workspaceId?: string | null;
}) {
  const t = useTranslations("dashboardChatFiles");
  const [busy, setBusy] = useState<ArtifactRecordScope | null>(null);
  const [clearScope, setClearScope] = useState<ArtifactRecordScope | null>(
    null,
  );
  const [isClearing, setIsClearing] = useState(false);

  const capabilities = htmlArtifactRecordCapabilities(artifact.payloadJson);
  if (
    !workspaceId ||
    artifact.artifactType !== "html" ||
    artifact.status !== "ready" ||
    !capabilities.storage
  )
    return null;

  const scopes: ArtifactRecordScope[] = capabilities.shared
    ? ["user", "shared"]
    : ["user"];

  async function handleExport(scope: ArtifactRecordScope) {
    if (!workspaceId || busy) return;
    setBusy(scope);
    try {
      const blob = await contentClient.exportArtifactRecords(
        workspaceId,
        artifact.id,
        scope,
      );
      saveBlob(blob, pageDataFileName(title, scope));
      toast.success(t("pageData.toasts.exported"));
    } catch (error) {
      toast.error(getErrorMessage(error, t("pageData.toasts.exportFailed")));
    } finally {
      setBusy(null);
    }
  }

  async function handleClear() {
    if (!workspaceId || !clearScope || isClearing) return;
    setIsClearing(true);
    try {
      const result = await contentClient.clearArtifactRecords(
        workspaceId,
        artifact.id,
        clearScope,
      );
      toast.success(t("pageData.toasts.cleared", { count: result.removed }));
      setClearScope(null);
    } catch (error) {
      toast.error(getErrorMessage(error, t("pageData.toasts.clearFailed")));
    } finally {
      setIsClearing(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border bg-background/70 p-3">
      <div className="flex items-center gap-1.5">
        <Database className="size-3.5 text-muted-foreground" />
        <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {t("pageData.title")}
        </p>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {t("pageData.description")}
      </p>
      <ul className="mt-2 divide-y">
        {scopes.map((scope) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 py-2"
            key={scope}
          >
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">
                {t(`pageData.scopes.${scope}.label`)}
              </p>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {t(`pageData.scopes.${scope}.hint`)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                className="gap-1.5"
                disabled={busy !== null}
                onClick={() => void handleExport(scope)}
                size="xs"
                type="button"
                variant="outline"
              >
                {busy === scope ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {t("pageData.actions.export")}
              </Button>
              <Button
                className="gap-1.5 text-muted-foreground hover:text-destructive"
                disabled={busy !== null}
                onClick={() => setClearScope(scope)}
                size="xs"
                type="button"
                variant="outline"
              >
                <Trash2 className="size-3.5" />
                {t("pageData.actions.clear")}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !isClearing) setClearScope(null);
        }}
        open={clearScope !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(`pageData.clearDialog.${clearScope ?? "user"}.title`)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(`pageData.clearDialog.${clearScope ?? "user"}.description`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
            <span className="line-clamp-2 break-words">{title}</span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearing}>
              {t("actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={isClearing}
              onClick={(event) => {
                event.preventDefault();
                void handleClear();
              }}
            >
              {isClearing ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("pageData.actions.clearing")}
                </>
              ) : (
                t("pageData.actions.clearConfirm")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
