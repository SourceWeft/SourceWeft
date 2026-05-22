"use client";

import { useEffect } from "react";
import { ArrowLeft, Download, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { GeneratedImagePreview } from "../chat-canvas/generated-image-preview";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  artifactTitle,
  artifactTypeLabel,
  resolveArtifactDownloadUrl,
  resolveArtifactFileUrl,
} from "./artifacts";
import { TypeBadge } from "./type-badge";
import type { ArtifactListItem } from "./types";

export function ArtifactPreviewPanel({
  artifact,
  className,
  onClose,
  workspaceId,
}: {
  artifact: ArtifactListItem;
  className?: string;
  onClose: () => void;
  workspaceId?: string | null;
}) {
  const fileUrl = resolveArtifactFileUrl({ artifact, workspaceId });
  const downloadUrl = resolveArtifactDownloadUrl({ artifact, workspaceId });
  const title = artifactTitle(artifact);
  const canPreviewImage =
    artifact.artifactType === "image" &&
    artifact.status === "ready" &&
    Boolean(fileUrl);

  useEffect(() => {
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
    if (!fileUrl) {
      toast.error("This artifact has no preview file.");
      return;
    }
    window.open(fileUrl, "_blank", "noopener,noreferrer");
  };

  const handleDownload = () => {
    if (!downloadUrl) {
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

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col border-l bg-background text-foreground",
        className,
      )}
    >
      <div className="shrink-0 border-b bg-muted/20 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <Button
            className="gap-1.5"
            onClick={onClose}
            size="xs"
            type="button"
            variant="ghost"
          >
            <ArrowLeft className="size-3.5" />
            Artifacts
          </Button>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              disabled={!fileUrl}
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
              disabled={!downloadUrl}
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

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/10 px-3 py-3">
        {artifact.status === "pending" || artifact.status === "running" ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-background/70 px-5 text-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Artifact is still generating
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Preview will be available when the image is ready.
              </p>
            </div>
          </div>
        ) : artifact.status === "failed" ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
            <p className="text-sm font-medium text-destructive">
              Artifact generation failed
            </p>
            <p className="mt-2 text-xs leading-5 text-destructive/80">
              {artifact.errorMessage || "No error details were saved."}
            </p>
          </div>
        ) : canPreviewImage && fileUrl ? (
          <div className="flex min-h-80 items-center justify-center rounded-xl bg-background p-2">
            <GeneratedImagePreview
              className="w-full [&>span]:mx-auto [&>span]:grid [&>span]:min-h-80 [&>span]:w-full [&>span]:max-w-full [&>span]:place-items-center [&>span>img]:max-h-[calc(100vh-15rem)] [&>span>img]:max-w-full"
              downloadUrl={downloadUrl ?? fileUrl}
              imageUrl={fileUrl}
              title={title}
            />
          </div>
        ) : (
          <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed bg-background/70 px-5 text-center">
            <div>
              <Sparkles className="mx-auto mb-3 size-5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">
                Preview is not available
              </p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Image artifacts can be previewed here. This artifact type is
                kept compatible for future preview renderers.
              </p>
            </div>
          </div>
        )}

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
