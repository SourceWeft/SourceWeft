"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  artifactVersionMediaProjectionSchema,
  type ShareLink,
} from "@sourceweft/contracts";
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
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient } from "../../../../../lib/sdk";
import { ShareArtifactDialog } from "./share-artifact-dialog";
import {
  artifactTitle,
  artifactTypeLabel,
  resolveArtifactDownloadUrl,
  resolveArtifactPageUrl,
  resolveArtifactProxyFileUrl,
} from "../sources-hub/artifacts";
import { emitArtifactDeleted } from "../sources-hub/artifacts/artifact-delete-events";
import { getErrorMessage } from "../sources-hub/lib/errors";
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
import { withArtifactVersionMediaProxyUrls } from "../chat-canvas/use-artifact-version-media";

export function ArtifactPreviewPanel({
  artifact,
  className,
  layout = "panel",
  onClose,
  onDeleted,
  workspaceId,
}: {
  artifact: ArtifactListItem;
  className?: string;
  layout?: ArtifactPreviewLayout;
  onClose?: () => void;
  /** After a successful delete; defaults to `onClose` when omitted. */
  onDeleted?: () => void;
  workspaceId?: string | null;
}) {
  const pageUrl = resolveArtifactPageUrl({ artifact, workspaceId });
  const proxyFileUrl = resolveArtifactProxyFileUrl({ artifact, workspaceId });
  const downloadUrl = resolveArtifactDownloadUrl({ artifact, workspaceId });
  const title = artifactTitle(artifact);
  const storedPayload = payloadRecord(artifact);
  const versionMedia =
    artifactVersionMediaProjectionSchema.safeParse(storedPayload);
  const payload =
    versionMedia.success && workspaceId
      ? withArtifactVersionMediaProxyUrls(versionMedia.data, workspaceId)
      : storedPayload;
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
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Sharing publishes a finished artifact publicly; only offer it once the
  // artifact is ready and we know which workspace it lives in.
  const canShare = artifact.status === "ready" && Boolean(workspaceId);
  const canDelete = Boolean(workspaceId);

  // The share state is owned here, not by the dialog: the header badge needs
  // it before the dialog ever opens, and the dialog's mutations flow back
  // through setShare so badge and dialog can never disagree.
  const [share, setShare] = useState<ShareLink | null>(null);
  const [isShareLoading, setIsShareLoading] = useState(false);

  useEffect(() => {
    setShare(null);
    if (!canShare || !workspaceId) {
      return;
    }
    let cancelled = false;
    setIsShareLoading(true);
    contentClient
      .getArtifactShare(workspaceId, artifact.id)
      .then((result) => {
        if (!cancelled) setShare(result.share);
      })
      .catch(() => {
        // Not being allowed to read share state (e.g. not the creator) simply
        // means no badge; the dialog surfaces its own errors on mutation.
      })
      .finally(() => {
        if (!cancelled) setIsShareLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, canShare, workspaceId]);

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

  const handleDelete = async () => {
    if (!workspaceId || isDeleting) {
      return;
    }
    setIsDeleting(true);
    try {
      await contentClient.deleteArtifact(workspaceId, artifact.id);
      emitArtifactDeleted({ workspaceId, artifactId: artifact.id });
      toast.success("Artifact deleted.");
      setDeleteOpen(false);
      (onDeleted ?? onClose)?.();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not delete the artifact."));
    } finally {
      setIsDeleting(false);
    }
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
            {canShare ? (
              <Button
                onClick={() => setShareOpen(true)}
                size="icon-xs"
                title="Share artifact"
                type="button"
                variant="ghost"
              >
                <Share2 className="size-3.5" />
                <span className="sr-only">Share artifact</span>
              </Button>
            ) : null}
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
              disabled={
                !downloadUrl || !canDownloadFile || !canUseDefaultDownload
              }
              onClick={handleDownload}
              size="icon-xs"
              title="Download artifact"
              type="button"
              variant="ghost"
            >
              <Download className="size-3.5" />
              <span className="sr-only">Download artifact</span>
            </Button>
            {canDelete ? (
              <Button
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                size="icon-xs"
                title="Delete artifact"
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
                <span className="sr-only">Delete artifact</span>
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-2 min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
              {title}
            </h3>
            {share ? (
              <button
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
                onClick={() => setShareOpen(true)}
                title="Shared publicly — manage the link"
                type="button"
              >
                <Globe className="size-3" />
                Public
              </button>
            ) : null}
          </div>
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
          {artifact.status === "failed" &&
          (artifact.errorMessage || artifact.errorCode) ? (
            <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2">
              {artifact.errorCode ? (
                <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-destructive">
                  {artifact.errorCode}
                </p>
              ) : null}
              <p className="mt-0.5 break-words text-xs leading-5 text-destructive/80">
                {artifact.errorMessage || "No error details were saved."}
              </p>
            </div>
          ) : null}
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

      {canShare && workspaceId ? (
        <ShareArtifactDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          workspaceId={workspaceId}
          artifactId={artifact.id}
          title={title}
          share={share}
          isShareLoading={isShareLoading}
          onShareChange={setShare}
        />
      ) : null}

      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete artifact?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the artifact and disables its public
              link. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">
            <span className="line-clamp-2 break-words">{title}</span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
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
    </section>
  );
}
