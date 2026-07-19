import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  Download,
  ImageIcon,
  Loader2,
  Presentation,
} from "lucide-react";
import {
  AGENT_TOOL_NAMES,
  hasAgentToolCapability,
} from "@sourceweft/agent-tool-registry";
import {
} from "@sourceweft/ui-web/components/ai-elements/chain-of-thought";
import {
} from "@sourceweft/ui-web/components/ai-elements/queue";
import {
} from "@sourceweft/ui-web/components/ai-elements/task";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { RawImage } from "../../../../_components/raw-image";
import { apiBaseUrl } from "../../../../../lib/sdk";
import { resolveArtifactPageUrl } from "../artifact-urls";
import {
} from "./tool-confirmation-state";
import {
  type GeneratedPresentationArtifactStatus,
  resolveArtifactDownloadUrl,
  resolveArtifactFileUrl,
  resolveArtifactUrl,
  resolveGeneratedImageArtifact,
  resolveGeneratedPresentationArtifact,
  resolveGeneratedPresentationPreviewImageUrl,
} from "./message-assets";
import { GeneratedImagePreview } from "./generated-image-preview";
import {
  shouldShowGeneratedPresentationItem,
} from "./reasoning-trace-state";
import {
} from "./reasoning-trace-todos";
import {
  resolveDeliverableStatus,
  type DeliverableGenerationStatus,
} from "./artifact-progress";
import { resolveToolCallArtifactId } from "./artifact-work-state";
import {
  buildGeneratedPresentationPreviewArtifact,
  getGeneratedImageStatus,
  getGeneratedImageTitle,
  getGeneratedPresentationFileName,
  getGeneratedPresentationPrompt,
  getGeneratedPresentationTitle,
  getPresentationArtifactPreviewStatus,
  getVideoProjectStageLabel,
  isPresentationArtifactPending,
} from "./reasoning-trace-tools";
import { useArtifactSnapshot } from "./use-artifact-snapshot";
import type {
  ArtifactPreviewRecord,
  ArtifactStatusSnapshot,
  ToolCallRecord,
} from "./types";

function GeneratedImageLoadingMask({
  isVisible,
  title,
}: {
  isVisible: boolean;
  title: string;
}) {
  return (
    <div
      aria-hidden={!isVisible}
      aria-label="Generating image"
      className={cn(
        "absolute inset-0 z-10 overflow-hidden rounded-lg transition-opacity duration-500",
        isVisible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      role={isVisible ? "status" : undefined}
    >
      <div className="absolute inset-0 bg-[linear-gradient(145deg,hsl(var(--background))_0%,hsl(var(--muted))_44%,hsl(var(--background))_100%)]" />
      <div className="absolute inset-0 opacity-80 [background-image:radial-gradient(circle_at_18%_18%,hsl(var(--primary)/0.18),transparent_30%),radial-gradient(circle_at_82%_72%,hsl(var(--foreground)/0.10),transparent_30%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(105deg,transparent_0%,hsl(var(--foreground)/0.04)_30%,hsl(var(--foreground)/0.14)_48%,hsl(var(--foreground)/0.05)_66%,transparent_100%)] bg-[length:220%_100%] animate-[image-sheen_2.2s_ease-in-out_infinite]" />
      <div className="absolute inset-0 opacity-35 [background-image:linear-gradient(hsl(var(--foreground)/0.08)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.08)_1px,transparent_1px)] [background-size:40px_40px]" />
      <div className="absolute inset-5 rounded-md border border-background/60 bg-background/10 shadow-[inset_0_1px_0_hsl(var(--background)/0.65)]" />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background/90 via-background/45 to-transparent" />
      <div className="absolute right-4 bottom-4 left-4">
        <div className="rounded-md border border-border/70 bg-background/80 px-3 py-2 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {title}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Generating image
              </p>
            </div>
            <div className="grid size-6 shrink-0 place-items-center rounded-full border border-border/70 bg-background/70">
              <div className="size-2 rounded-full bg-primary shadow-[0_0_18px_hsl(var(--primary)/0.55)]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneratedImageArtifactItem({
  aspectRatio,
  artifactPageUrl,
  downloadUrl,
  imageFileUrl,
  status,
  title,
}: {
  aspectRatio: string;
  artifactPageUrl?: string | null;
  downloadUrl?: string | null;
  imageFileUrl?: string | null;
  status: ToolCallRecord["status"];
  title: string;
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const isPending = status === "running" || status === "approval_requested";
  const showMask = imageFileUrl ? !isImageLoaded && !hasImageError : isPending;

  useEffect(() => {
    setHasImageError(false);
    setIsImageLoaded(false);
  }, [imageFileUrl]);

  if (!imageFileUrl) {
    return (
      <div
        className="relative isolate max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg bg-muted/60"
        style={{ aspectRatio }}
      >
        <GeneratedImageLoadingMask isVisible={isPending} title={title} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative isolate max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg bg-muted/40",
        isImageLoaded && "bg-transparent",
      )}
      style={{ aspectRatio }}
    >
      <GeneratedImagePreview
        className={cn(
          "size-full transition-opacity duration-200 [&>span]:size-full [&>span]:min-h-0 [&>span]:min-w-0 [&>span>img]:h-full [&>span>img]:w-full [&>span>img]:object-contain",
          isImageLoaded && !hasImageError ? "opacity-100" : "opacity-0",
        )}
        downloadUrl={downloadUrl ?? imageFileUrl}
        imageUrl={imageFileUrl}
        onImageError={() => setHasImageError(true)}
        onImageLoad={() => setIsImageLoaded(true)}
        title={title}
      />
      {hasImageError ? (
        <div className="absolute inset-0 z-20 grid place-items-center rounded-lg border border-border/70 bg-background/90 p-4 text-center shadow-sm">
          <div className="max-w-64">
            <ImageIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              Image preview could not load
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Open or download the artifact to view the generated image.
            </p>
            <div className="mt-3 flex justify-center gap-2">
              {artifactPageUrl ? (
                <a
                  className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  href={artifactPageUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open
                </a>
              ) : null}
              {downloadUrl ? (
                <a
                  className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  href={downloadUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Download
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <GeneratedImageLoadingMask isVisible={showMask} title={title} />
    </div>
  );
}

function GeneratedImageArtifacts({
  toolCalls,
  workspaceId,
}: {
  toolCalls: ToolCallRecord[] | undefined;
  workspaceId?: string | null;
}) {
  const imageItems = (toolCalls ?? [])
    .filter((toolCall) =>
      hasAgentToolCapability(toolCall.tool, "generated_image_artifact"),
    )
    .map((toolCall) => {
      const artifact = resolveGeneratedImageArtifact(toolCall);
      const artifactPageUrl = artifact
        ? resolveArtifactUrl({ artifact, workspaceId })
        : null;
      const imageFileUrl = artifact
        ? resolveArtifactFileUrl({ artifact, workspaceId })
        : null;
      const downloadUrl = artifact
        ? resolveArtifactDownloadUrl({ artifact, workspaceId })
        : null;
      const title =
        artifact?.title ||
        getGeneratedImageTitle(toolCall) ||
        "Generated image";
      return {
        artifactPageUrl,
        downloadUrl,
        imageFileUrl,
        title,
        toolCall,
      };
    })
    .filter(({ imageFileUrl, toolCall }) => {
      if (
        toolCall.status === "running" ||
        toolCall.status === "approval_requested" ||
        toolCall.status === "error"
      ) {
        return true;
      }
      return Boolean(imageFileUrl);
    });

  if (imageItems.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {imageItems.map(
        ({ artifactPageUrl, downloadUrl, imageFileUrl, title, toolCall }) => {
          const imageStatus = getGeneratedImageStatus(toolCall);

          if (toolCall.status === "error") {
            return (
              <div
                className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                key={toolCall.id}
              >
                {toolCall.error ?? "Image generation failed."}
              </div>
            );
          }

          return (
            <GeneratedImageArtifactItem
              aspectRatio={imageStatus.aspectRatio}
              artifactPageUrl={artifactPageUrl}
              downloadUrl={downloadUrl ?? imageFileUrl}
              imageFileUrl={imageFileUrl}
              key={toolCall.id}
              status={toolCall.status}
              title={title}
            />
          );
        },
      )}
    </div>
  );
}

export function GeneratedImageArtifactBlock({
  toolCall,
  workspaceId,
}: {
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  toolCall: ToolCallRecord | undefined;
  workspaceId?: string | null;
}) {
  return (
    <GeneratedImageArtifacts
      toolCalls={toolCall ? [toolCall] : []}
      workspaceId={workspaceId}
    />
  );
}

function GeneratedPresentationArtifactItem({
  artifactStatus,
  artifactStatusSnapshot,
  artifactPreview,
  artifactFileName,
  description,
  downloadUrl,
  generationMode,
  isVideoPresentation,
  isArtifactPublisher,
  modeLabel,
  onArtifactPreview,
  previewImageUrl: toolOutputPreviewImageUrl,
  slideCount,
  sourceJsonUrl,
  status,
  title,
  videoPresentationStatus,
}: {
  artifactStatus?: GeneratedPresentationArtifactStatus | null;
  artifactStatusSnapshot?: ArtifactStatusSnapshot;
  artifactPreview?: ArtifactPreviewRecord | null;
  artifactFileName?: string | null;
  description?: string | null;
  downloadUrl?: string | null;
  generationMode?: "visual_html" | "editable_native" | null;
  isVideoPresentation?: boolean;
  isArtifactPublisher?: boolean;
  modeLabel: string;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  previewImageUrl?: string | null;
  slideCount?: number | null;
  sourceJsonUrl?: string | null;
  status: ToolCallRecord["status"];
  title: string;
  videoPresentationStatus?: DeliverableGenerationStatus | null;
}) {
  const previewStatus = artifactStatus ?? artifactPreview?.status ?? "pending";
  const effectiveArtifactPreview =
    artifactPreview && artifactStatusSnapshot
      ? ({
          ...artifactPreview,
          payloadJson:
            artifactStatusSnapshot?.payloadJson ?? artifactPreview.payloadJson,
          capabilities:
            artifactStatusSnapshot?.capabilities ??
            artifactPreview.capabilities,
          previewUrl:
            artifactStatusSnapshot?.previewUrl ?? artifactPreview.previewUrl,
          status: previewStatus,
          storageBucket:
            artifactStatusSnapshot?.storageBucket ??
            artifactPreview.storageBucket,
          storageKey:
            artifactStatusSnapshot?.storageKey ?? artifactPreview.storageKey,
          previewStorageKey:
            artifactStatusSnapshot?.previewStorageKey ??
            artifactPreview.previewStorageKey,
          previewMetadataJson:
            artifactStatusSnapshot?.previewMetadataJson ??
            artifactPreview.previewMetadataJson,
          completedAt:
            artifactStatus === "ready"
              ? (artifactStatusSnapshot?.completedAt ??
                artifactPreview.completedAt ??
                new Date().toISOString())
              : artifactPreview.completedAt,
          updatedAt:
            artifactStatusSnapshot?.updatedAt ?? new Date().toISOString(),
        } satisfies ArtifactPreviewRecord)
      : artifactPreview;
  const isArtifactPending = isPresentationArtifactPending(artifactStatus);
  const isArtifactError = artifactStatus === "failed";
  const videoProjectStageLabel = isVideoPresentation
    ? getVideoProjectStageLabel(
        artifactStatusSnapshot?.payloadJson ?? artifactPreview?.payloadJson,
      )
    : null;
  const isPending =
    status === "running" ||
    status === "approval_requested" ||
    (isVideoPresentation
      ? videoPresentationStatus === "pending" ||
        videoPresentationStatus === "running"
      : isArtifactPending);
  const isError = status === "error" || isArtifactError;
  const canPreview =
    Boolean(effectiveArtifactPreview && onArtifactPreview) &&
    !isPending &&
    !isError;
  const effectiveDownloadUrl = isVideoPresentation ? null : downloadUrl;
  const previewImageUrl = resolveGeneratedPresentationPreviewImageUrl({
    artifactPreview: effectiveArtifactPreview,
    previewImageUrl: toolOutputPreviewImageUrl,
  });
  const handleDownload = () => {
    if (!effectiveDownloadUrl) {
      return;
    }

    const link = document.createElement("a");
    link.href = effectiveDownloadUrl;
    link.download = getGeneratedPresentationFileName({
      artifactFileName,
      generationMode,
      title,
      videoPresentation: isVideoPresentation,
    });
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const handlePreview = () => {
    if (effectiveArtifactPreview && onArtifactPreview && canPreview) {
      onArtifactPreview(effectiveArtifactPreview);
    }
  };
  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handlePreview();
  };

  return (
    <div
      aria-label={canPreview ? `Open artifact preview for ${title}` : undefined}
      className={cn(
        "relative isolate w-full max-w-xl rounded-lg border border-border bg-background shadow-sm outline-none transition-[background-color,border-color,box-shadow]",
        canPreview &&
          "cursor-pointer hover:border-foreground/25 hover:bg-accent/40 hover:shadow-md hover:shadow-foreground/5 focus-visible:border-primary/45 focus-visible:bg-accent/30 focus-visible:shadow-[0_10px_30px_-22px_hsl(var(--foreground)/0.5),0_0_0_1px_hsl(var(--primary)/0.18)] focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:rounded-[inherit] focus-visible:after:shadow-[inset_0_0_0_2px_hsl(var(--ring)/0.55)] focus-visible:after:content-['']",
      )}
      onClick={canPreview ? handlePreview : undefined}
      onKeyDown={canPreview ? handlePreviewKeyDown : undefined}
      role={canPreview ? "button" : undefined}
      tabIndex={canPreview ? 0 : undefined}
    >
      <div className="flex items-start gap-3 p-3">
        <div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted/60">
          {previewImageUrl && !isPending && !isError ? (
            <RawImage
              alt={title}
              className="size-full object-cover"
              loading="lazy"
              src={previewImageUrl}
            />
          ) : isPending ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <Presentation className="size-5 text-foreground/80" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {title}
              </p>
              {description ? (
                <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              disabled={
                isPending ||
                isError ||
                (isVideoPresentation ? !canPreview : !effectiveDownloadUrl)
              }
              onClick={(event) => {
                event.stopPropagation();
                if (isVideoPresentation) {
                  handlePreview();
                  return;
                }
                handleDownload();
              }}
              title={
                isVideoPresentation
                  ? "Open video presentation"
                  : modeLabel === "Visual deck"
                    ? "Download HTML deck"
                    : "Download PPTX"
              }
              type="button"
            >
              <Download className="size-3.5" />
              {isVideoPresentation ? "Open Video" : "Download"}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5">
              {modeLabel}
            </span>
            {typeof slideCount === "number" ? (
              <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5">
                {slideCount} slides
              </span>
            ) : null}
            {sourceJsonUrl && !isPending && !isError ? (
              <a
                className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                href={sourceJsonUrl}
                onClick={(event) => event.stopPropagation()}
                rel="noopener"
              >
                Source JSON
              </a>
            ) : null}
            {isPending ? (
              <span>
                {isVideoPresentation
                  ? (videoProjectStageLabel ??
                    (artifactStatus === "running"
                      ? "Preparing video project..."
                      : "Preparing video project..."))
                  : isArtifactPublisher
                    ? "Publishing presentation..."
                    : "Generating presentation..."}
              </span>
            ) : null}
          </div>
          {isError ? (
            <p className="mt-2 text-xs text-destructive">
              {isVideoPresentation
                ? (videoProjectStageLabel ??
                  "Video presentation generation failed.")
                : isArtifactPublisher
                  ? "Presentation publishing failed."
                  : "PPTX generation failed."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GeneratedPresentationArtifacts({
  artifactStatuses,
  onArtifactPreview,
  toolCalls,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  toolCalls: ToolCallRecord[] | undefined;
  workspaceId?: string | null;
}) {
  const presentationItems = (toolCalls ?? [])
    .filter(
      (toolCall) =>
        hasAgentToolCapability(toolCall.tool, "presentation_artifact") ||
        hasAgentToolCapability(toolCall.tool, "video_presentation_artifact"),
    )
    .map((toolCall) => {
      const isVideoPresentation = hasAgentToolCapability(
        toolCall.tool,
        "video_presentation_artifact",
      );
      const isArtifactPublisher =
        toolCall.tool === AGENT_TOOL_NAMES.publishArtifact;
      const artifact = resolveGeneratedPresentationArtifact(toolCall);
      const fileUrl = artifact
        ? resolveArtifactUrl({ artifact, workspaceId })
        : null;
      const downloadUrl = artifact
        ? resolveArtifactDownloadUrl({ artifact, workspaceId })
        : null;
      const sourceJsonUrl =
        artifact?.sourceJsonUrl &&
        (artifact.sourceJsonUrl.startsWith("http")
          ? artifact.sourceJsonUrl
          : `${apiBaseUrl}${artifact.sourceJsonUrl}`);
      const title =
        artifact?.title ||
        getGeneratedPresentationTitle(toolCall) ||
        (isArtifactPublisher
          ? "Published presentation"
          : isVideoPresentation
            ? "Generated video presentation"
            : "Generated presentation");
      const description = getGeneratedPresentationPrompt(toolCall);
      const generationMode =
        artifact?.generationMode ??
        (artifact?.htmlUrl ? "visual_html" : "editable_native");
      const modeLabel = isVideoPresentation
        ? "Video presentation"
        : isArtifactPublisher
          ? "PowerPoint presentation"
          : generationMode === "editable_native"
            ? "Editable PowerPoint"
            : "Visual deck";
      const artifactStatusSnapshot = artifact?.artifactId
        ? artifactStatuses?.get(artifact.artifactId)
        : undefined;
      const resolvedVideoPresentationStatus = isVideoPresentation
        ? resolveDeliverableStatus({
            artifactSnapshot: artifactStatusSnapshot,
            toolCallOutput: toolCall.output,
            toolCallStatus: toolCall.status,
            toolName: toolCall.tool,
          })
        : null;
      const artifactStatus = getPresentationArtifactPreviewStatus({
        isVideoPresentation,
        status: isVideoPresentation
          ? (resolvedVideoPresentationStatus ?? undefined)
          : ((artifactStatusSnapshot?.status as
              | GeneratedPresentationArtifactStatus
              | undefined) ??
              artifact?.status ??
              undefined),
      });
      const previewArtifact =
        artifact && (fileUrl || isVideoPresentation)
          ? buildGeneratedPresentationPreviewArtifact({
              artifactId: artifact.artifactId,
              description,
              fileUrl:
                fileUrl ??
                (artifact.artifactId && workspaceId
                  ? resolveArtifactPageUrl({
                      artifactId: artifact.artifactId,
                      workspaceId,
                    })
                  : null),
              generationMode,
              isVideoPresentation,
              source: artifact,
              title,
              workspaceId,
            })
          : null;
      return {
        artifact,
        artifactStatus,
        artifactStatusSnapshot,
        downloadUrl,
        fileUrl: isVideoPresentation ? null : fileUrl,
        generationMode,
        isVideoPresentation,
        isArtifactPublisher,
        previewArtifact,
        previewImageUrl: artifact?.previewImageUrl ?? null,
        description,
        modeLabel,
        sourceJsonUrl,
        title,
        toolCall,
        videoPresentationStatus: resolvedVideoPresentationStatus,
      };
    })
    .filter((item) =>
      shouldShowGeneratedPresentationItem({
        fileUrl: item.fileUrl,
        isArtifactPublisher: item.isArtifactPublisher,
        isVideoPresentation: item.isVideoPresentation,
        previewArtifact: item.previewArtifact,
        status: item.toolCall.status,
      }),
    )
    .filter((item, index, items) => {
      if (!item.artifact?.artifactId) {
        return true;
      }
      return (
        items.findIndex(
          (candidate) =>
            candidate.artifact?.artifactId === item.artifact?.artifactId,
        ) === index
      );
    });

  if (presentationItems.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {presentationItems.map(
        ({
          artifact,
          artifactStatus,
          artifactStatusSnapshot,
          description,
          downloadUrl,
          fileUrl,
          generationMode,
          isVideoPresentation,
          isArtifactPublisher,
          modeLabel,
          previewArtifact,
          previewImageUrl,
          title,
          sourceJsonUrl,
          toolCall,
          videoPresentationStatus,
        }) => {
          if (toolCall.status === "error") {
            return (
              <div
                className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                key={toolCall.id}
              >
                {toolCall.error ??
                  (isVideoPresentation
                    ? "Video presentation generation failed."
                    : "PPTX generation failed.")}
              </div>
            );
          }

          return (
            <GeneratedPresentationArtifactItem
              artifactStatus={artifactStatus}
              artifactStatusSnapshot={artifactStatusSnapshot}
              artifactPreview={previewArtifact}
              artifactFileName={artifact?.fileName}
              description={description}
              downloadUrl={downloadUrl ?? fileUrl}
              generationMode={generationMode}
              isVideoPresentation={isVideoPresentation}
              isArtifactPublisher={isArtifactPublisher}
              key={toolCall.id}
              modeLabel={modeLabel}
              onArtifactPreview={onArtifactPreview}
              previewImageUrl={previewImageUrl}
              slideCount={artifact?.slideCount}
              sourceJsonUrl={sourceJsonUrl}
              status={toolCall.status}
              title={title}
              videoPresentationStatus={videoPresentationStatus}
            />
          );
        },
      )}
    </div>
  );
}

export function GeneratedPresentationArtifactBlock({
  artifactStatuses,
  onArtifactPreview,
  toolCall,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  toolCall: ToolCallRecord | undefined;
  workspaceId?: string | null;
}) {
  const artifactId = resolveToolCallArtifactId(toolCall?.output);
  const { snapshot } = useArtifactSnapshot({
    artifactSnapshot: artifactId
      ? artifactStatuses?.get(artifactId)
      : undefined,
    enabled: Boolean(toolCall && artifactId),
    toolCallOutput: toolCall?.output,
    workspaceId,
  });
  const effectiveArtifactStatuses = useMemo(() => {
    if (!snapshot) {
      return artifactStatuses;
    }
    const next = new Map(artifactStatuses ?? []);
    next.set(snapshot.id, snapshot);
    return next;
  }, [artifactStatuses, snapshot]);

  return (
    <GeneratedPresentationArtifacts
      artifactStatuses={effectiveArtifactStatuses}
      onArtifactPreview={onArtifactPreview}
      toolCalls={toolCall ? [toolCall] : []}
      workspaceId={workspaceId}
    />
  );
}
