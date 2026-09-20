"use client";

import { useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Preview } from "@sourceweft/preview/react";
import type { PreviewSource } from "@sourceweft/preview";
import { Download, Loader2, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { basename } from "./workfile-content-preview";
import { desktopBridge } from "../../../../lib/desktop-bridge";
import { DesktopFilePreviewLauncher } from "./desktop-file-preview-launcher";

const subscribeToDesktop = () => () => {};
const serverDesktop = () => false;

/** Shared in-app reader for cloud Files and physical PC files. */
export function FilePreviewDialog({
  open,
  onOpenChange,
  path,
  description,
  contentText,
  source,
  mimeType,
  loading = false,
  error,
  onRetry,
  onDownload,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string;
  description?: string;
  contentText?: string;
  source?: PreviewSource;
  mimeType?: string | null;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onDownload?: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations("dashboardChatFiles");
  const contentRef = useRef<HTMLDivElement>(null);
  const desktop = useSyncExternalStore(
    subscribeToDesktop,
    desktopBridge.isAvailable,
    serverDesktop,
  );
  const previewSource = useMemo(
    () =>
      source ??
      (contentText === undefined
        ? undefined
        : {
            name: path,
            mimeType,
            text: contentText,
          }),
    [source, contentText, path, mimeType],
  );
  if (desktop)
    return (
      <DesktopFilePreviewLauncher
        open={open}
        source={previewSource}
        description={description ?? path}
        loading={loading}
        error={error}
        onOpened={() => onOpenChange(false)}
        onRetry={onRetry}
      />
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid h-svh w-full max-w-full grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[min(720px,calc(100svh-2rem))] sm:w-[900px] sm:max-w-[calc(100%-2rem)] sm:rounded-xl sm:border"
        constrainWidth={false}
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        <DialogHeader className="min-w-0 space-y-2 border-b px-4 py-3 text-left">
          <div className="flex min-w-0 items-center gap-2 pr-7">
            <DialogTitle className="min-w-0 flex-1 truncate" title={path}>
              {path ? basename(path) : t("filePreview.titleFallback")}
            </DialogTitle>
            {onRetry && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("actions.refreshPreview")}
                disabled={loading}
                onClick={onRetry}
              >
                <RefreshCw className="size-4" />
              </Button>
            )}
            {onDownload && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("actions.downloadFile")}
                onClick={onDownload}
              >
                <Download className="size-4" />
              </Button>
            )}
          </div>
          <DialogDescription
            className="truncate text-xs"
            title={description ?? path}
          >
            {description ?? path}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={contentRef}
          role="document"
          aria-label={t("filePreview.contentsAria")}
          tabIndex={-1}
          className="min-h-0 min-w-0 overflow-hidden outline-none"
          aria-busy={loading}
        >
          {loading ? (
            <div
              role="status"
              className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" />
              {t("filePreview.loading")}
            </div>
          ) : error ? (
            <div
              role="alert"
              className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground"
            >
              {error}
            </div>
          ) : contentText === "" ? (
            <p className="text-sm text-muted-foreground">
              {t("filePreview.empty")}
            </p>
          ) : previewSource ? (
            <Preview key={path} className="h-full" source={previewSource} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
