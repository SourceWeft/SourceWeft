"use client";

import { useEffect } from "react";
import { ArrowLeft, Download, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  artifactTitle,
  artifactTypeLabel,
  resolveArtifactDownloadUrl,
  resolveArtifactPageUrl,
  resolveArtifactProxyFileUrl,
} from "../sources-hub/artifacts";
import { TypeBadge } from "../sources-hub/type-badge";
import type { ArtifactListItem } from "../sources-hub/types";
import {
  FailedArtifactPreview,
  PendingArtifactPreview,
  UnsupportedArtifactPreview,
} from "./fallbacks";
import { resolveArtifactPreviewRenderer } from "./preview-registry";
import type { ArtifactPreviewLayout } from "./types";
import { isArtifactPending, payloadRecord } from "./utils";

export function ArtifactPreviewPanel({
  artifact,
  className,
  layout = "panel",
  onClose,
  workspaceId,
}: {
  artifact: ArtifactListItem;
  className?: string;
  layout?: ArtifactPreviewLayout;
  onClose?: () => void;
  workspaceId?: string | null;
}) {
  const pageUrl = resolveArtifactPageUrl({ artifact, workspaceId });
  const proxyFileUrl = resolveArtifactProxyFileUrl({ artifact, workspaceId });
  const downloadUrl = resolveArtifactDownloadUrl({ artifact, workspaceId });
  const title = artifactTitle(artifact);
  const payload = payloadRecord(artifact);
  const previewContext = {
    artifact,
    downloadUrl,
    layout,
    pageUrl,
    payload,
    proxyFileUrl,
    title,
    workspaceId,
  };
  const renderer = resolveArtifactPreviewRenderer(previewContext);
  const canOpenFile = artifact.capabilities?.canOpenFile ?? Boolean(pageUrl);
  const canDownloadFile =
    artifact.capabilities?.canDownloadFile ?? Boolean(downloadUrl);
  const canUseDefaultOpen = !renderer?.blocksDefaultOpen;
  const canUseDefaultDownload = !renderer?.blocksDefaultDownload;

  useEffect(() => {
    if (!onClose) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [onClose]);

  const handleOpenExternal = () => {
    if (!canUseDefaultOpen) {
      toast.error("Open is handled by this artifact preview.");
      return;
    }
    if (!canOpenFile || !pageUrl) {
      toast.error("This artifact has no preview file.");
      return;
    }
    window.open(pageUrl, "_blank", "noopener,noreferrer");
  };

  const handleDownload = () => {
    if (!canUseDefaultDownload) {
      toast.error("Use the download action inside this artifact preview.");
      return;
    }
    if (!canDownloadFile || !downloadUrl) {
      toast.error("This artifact has no downloadable file.");
      return;
    }

    const link = document.createElement("a");
    link.href = downloadUrl;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const isPageLayout = layout === "page";
  const previewContent = renderer ? (
    renderer.render(previewContext)
  ) : isArtifactPending(artifact) ? (
    <PendingArtifactPreview />
  ) : artifact.status === "failed" ? (
    <FailedArtifactPreview message={artifact.errorMessage} />
  ) : (
    <UnsupportedArtifactPreview />
  );

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col bg-background text-foreground",
        isPageLayout ? "overflow-hidden" : "border-l",
        className,
      )}
    >
      <div
        className={cn(
          "shrink-0 border-b bg-muted/20",
          isPageLayout ? "px-4 py-3 sm:px-5" : "px-3 py-3",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          {onClose ? (
            <Button
              className="gap-1.5"
              onClick={onClose}
              size="xs"
              type="button"
              variant="ghost"
            >
              {isPageLayout ? (
                <X className="size-3.5" />
              ) : (
                <ArrowLeft className="size-3.5" />
              )}
              {isPageLayout ? "Close" : "Artifacts"}
            </Button>
          ) : (
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Artifact Preview
              </p>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              disabled={!pageUrl || !canOpenFile || !canUseDefaultOpen}
              onClick={handleOpenExternal}
              size="icon-xs"
              title="Open artifact in new tab"
              type="button"
              variant="ghost"
            >
              <ExternalLink className="size-3.5" />
              <span className="sr-only">Open artifact in new tab</span>
            </Button>
            <Button
              disabled={!downloadUrl || !canDownloadFile || !canUseDefaultDownload}
              onClick={handleDownload}
              size="icon-xs"
              title="Download artifact"
              type="button"
              variant="ghost"
            >
              <Download className="size-3.5" />
              <span className="sr-only">Download artifact</span>
            </Button>
          </div>
        </div>

        <div className="mt-2 min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">
            {title}
          </h3>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <TypeBadge label={artifactTypeLabel(artifact.artifactType)} />
            <TypeBadge label={artifact.status} />
            <span>{new Date(artifact.createdAt).toLocaleString()}</span>
            {artifact.completedAt ? (
              <span>
                completed {new Date(artifact.completedAt).toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto bg-muted/10",
          isPageLayout ? "px-4 py-4 sm:px-5" : "px-3 py-3",
        )}
      >
        {previewContent}

        {artifact.promptText ? (
          <div className="mt-3 rounded-xl border bg-background/70 p-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Prompt
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {artifact.promptText}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
