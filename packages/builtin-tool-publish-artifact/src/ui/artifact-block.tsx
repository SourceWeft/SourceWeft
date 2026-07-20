"use client";

/**
 * `publish_artifact`'s card in the message stream.
 *
 * The card is statically *this* capability's: the wording, the download name,
 * the chips and the preview row it hands to the panel are all published-deck
 * vocabulary, decoded in `./artifact-view`. The shell it renders into is
 * capability-neutral and lives in `@sourceweft/ui-web`.
 *
 * NOTE: `isArtifactPublisher` is structurally always true here — `renderAs:
 * "pptx"` is declared by `publish_artifact` alone, and the artifact reader
 * below refuses any other tool. The alternate wording is carried over verbatim
 * from the app-owned version rather than collapsed; removing it is a separate
 * decision.
 */
import { useMemo } from "react";
import { Download, Presentation } from "lucide-react";
import {
  artifactRenderHost,
  type ArtifactBlockProps,
  type ArtifactPreviewRecord,
  type ArtifactStatusSnapshot,
} from "@sourceweft/contracts/artifact-ui";
import {
  ArtifactBlockError,
  ArtifactCard,
  type ArtifactCardBadge,
} from "@sourceweft/ui-web/components/artifact-block/artifact-card";
import { PUBLISH_ARTIFACT_TOOL_NAME } from "../agent-tool-defs";
import {
  buildPublishedPresentationPreviewRecord,
  getPublishedPresentationFileName,
  getPublishedPresentationToolCallBrief,
  getPublishedPresentationToolCallTitle,
  isPublishedPresentationPending,
  resolvePublishedPresentationArtifact,
  shouldShowPublishedPresentationItem,
  type PublishedPresentationArtifactStatus,
} from "./artifact-view";

/**
 * The thumbnail for a published deck: the URL the run reported if it gave one,
 * otherwise whatever preview image the stored row carries.
 */
export function resolvePublishedPresentationThumbnailUrl(input: {
  artifactPreview?: Pick<
    ArtifactPreviewRecord,
    "id" | "previewMetadataJson" | "previewStorageKey" | "workspaceId"
  > | null;
  previewImageUrl?: string | null;
}) {
  const host = artifactRenderHost();
  const previewImageUrl =
    typeof input.previewImageUrl === "string" &&
    input.previewImageUrl.trim().length > 0
      ? input.previewImageUrl.trim()
      : null;
  if (previewImageUrl) {
    return host.resolveArtifactFileUrl({ fallbackUrl: previewImageUrl });
  }

  return host.resolveArtifactPreviewImageUrl({
    artifactId: input.artifactPreview?.id,
    previewMetadataJson: input.artifactPreview?.previewMetadataJson,
    previewStorageKey: input.artifactPreview?.previewStorageKey,
    workspaceId: input.artifactPreview?.workspaceId,
  });
}

/**
 * The row the preview panel receives, with anything the live artifact snapshot
 * already knows preferred over what the tool output guessed.
 */
function withSnapshot(
  record: ArtifactPreviewRecord | null,
  snapshot: ArtifactStatusSnapshot | undefined,
  status: ArtifactPreviewRecord["status"],
  artifactStatus: PublishedPresentationArtifactStatus | null,
): ArtifactPreviewRecord | null {
  if (!record || !snapshot) {
    return record;
  }
  return {
    ...record,
    payloadJson: snapshot.payloadJson ?? record.payloadJson,
    capabilities: snapshot.capabilities ?? record.capabilities,
    previewUrl: snapshot.previewUrl ?? record.previewUrl,
    status,
    storageBucket: snapshot.storageBucket ?? record.storageBucket,
    storageKey: snapshot.storageKey ?? record.storageKey,
    previewStorageKey: snapshot.previewStorageKey ?? record.previewStorageKey,
    previewMetadataJson:
      snapshot.previewMetadataJson ?? record.previewMetadataJson,
    completedAt:
      artifactStatus === "ready"
        ? (snapshot.completedAt ?? record.completedAt ?? new Date().toISOString())
        : record.completedAt,
    updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
  };
}

export function PublishedPresentationArtifactBlock({
  artifactStatuses,
  onArtifactPreview,
  toolCall,
  workspaceId,
}: ArtifactBlockProps) {
  const host = artifactRenderHost();
  const toolCallArtifactId = toolCall
    ? (host.readToolOutputField(toolCall.output, "artifact_id") ??
      host.readToolOutputField(toolCall.output, "artifactId") ??
      undefined)
    : undefined;
  const { snapshot } = host.useArtifactSnapshot({
    artifactSnapshot: toolCallArtifactId
      ? artifactStatuses?.get(toolCallArtifactId)
      : undefined,
    enabled: Boolean(toolCall && toolCallArtifactId),
    toolCallOutput: toolCall?.output,
    workspaceId,
  });
  const effectiveStatuses = useMemo(() => {
    if (!snapshot) {
      return artifactStatuses;
    }
    const next = new Map(artifactStatuses ?? []);
    next.set(snapshot.id, snapshot);
    return next;
  }, [artifactStatuses, snapshot]);

  if (!toolCall) {
    return null;
  }

  const isArtifactPublisher = toolCall.tool === PUBLISH_ARTIFACT_TOOL_NAME;
  const artifact = resolvePublishedPresentationArtifact({
    readField: (key) => host.readToolOutputField(toolCall.output, key),
    readValue: (key) => host.readToolOutputValue(toolCall.output, key),
    toolCall,
  });
  const fileUrl = artifact
    ? host.resolveArtifactPageUrl({
        artifactId: artifact.artifactId,
        fallbackUrl: artifact.artifactUrl,
        workspaceId,
      })
    : null;
  const downloadUrl = artifact
    ? host.resolveArtifactFileUrl({
        artifactId: artifact.artifactId,
        download: true,
        fallbackUrl: artifact.artifactUrl,
        workspaceId,
      })
    : null;
  const sourceJsonUrl = artifact?.sourceJsonUrl
    ? host.resolveApiAssetUrl(artifact.sourceJsonUrl)
    : null;
  const title =
    artifact?.title ||
    getPublishedPresentationToolCallTitle(toolCall) ||
    (isArtifactPublisher ? "Published presentation" : "Generated presentation");
  const description = getPublishedPresentationToolCallBrief(toolCall);
  const generationMode =
    artifact?.generationMode ??
    (artifact?.htmlUrl ? "visual_html" : "editable_native");
  const modeLabel = isArtifactPublisher
    ? "PowerPoint presentation"
    : generationMode === "editable_native"
      ? "Editable PowerPoint"
      : "Visual deck";
  const artifactSnapshot = artifact?.artifactId
    ? effectiveStatuses?.get(artifact.artifactId)
    : undefined;
  const previewRecord = buildPublishedPresentationPreviewRecord({
    artifactId: artifact?.artifactId ?? null,
    description,
    fileUrl,
    generationMode,
    source: artifact ?? {},
    title,
    workspaceId,
  });

  if (
    !shouldShowPublishedPresentationItem({
      fileUrl,
      isArtifactPublisher,
      status: toolCall.status,
    })
  ) {
    return null;
  }

  // NOTE: unreachable while `isArtifactPublisher` holds — the rule above
  // already hides an errored publish. Carried over verbatim.
  if (toolCall.status === "error") {
    return (
      <ArtifactBlockError message={toolCall.error ?? "PPTX generation failed."} />
    );
  }

  // A published deck is finished the moment it has an artifact URL, so the row
  // is `ready` as soon as there is a row at all — there is no live generation
  // status to track, and therefore no pending or failed artifact state.
  const artifactStatus = previewRecord?.status ?? null;
  const effectiveRecord = withSnapshot(
    previewRecord,
    artifactSnapshot,
    artifactStatus ?? "pending",
    artifactStatus,
  );
  const isPending =
    toolCall.status === "running" ||
    toolCall.status === "approval_requested" ||
    isPublishedPresentationPending(artifactStatus);
  // The tool-call error case returned above; a published deck row itself is
  // never in a failed state, so this is provably false today.
  const isError = artifactStatus === "failed";
  const canPreview =
    Boolean(effectiveRecord && onArtifactPreview) && !isPending && !isError;
  const handleDownload = () => {
    const href = downloadUrl ?? fileUrl;
    if (!href) {
      return;
    }

    const link = document.createElement("a");
    link.href = href;
    link.download = getPublishedPresentationFileName({
      artifactFileName: artifact?.fileName,
      generationMode,
      title,
    });
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const handlePreview = () => {
    if (effectiveRecord && onArtifactPreview && canPreview) {
      onArtifactPreview(effectiveRecord);
    }
  };

  const badges: ArtifactCardBadge[] = [{ label: modeLabel }];
  if (typeof artifact?.slideCount === "number") {
    badges.push({ label: `${artifact.slideCount} slides` });
  }
  if (sourceJsonUrl && !isPending && !isError) {
    badges.push({ href: sourceJsonUrl, label: "Source JSON" });
  }

  return (
    <div className="space-y-3">
      <ArtifactCard
        action={{
          disabled: isPending || isError || !(downloadUrl ?? fileUrl),
          icon: <Download className="size-3.5" />,
          label: "Download",
          onClick: handleDownload,
          title:
            modeLabel === "Visual deck" ? "Download HTML deck" : "Download PPTX",
        }}
        badges={badges}
        description={description}
        errorText={
          isArtifactPublisher
            ? "Presentation publishing failed."
            : "PPTX generation failed."
        }
        fallbackIcon={<Presentation className="size-5 text-foreground/80" />}
        isError={isError}
        isPending={isPending}
        onActivate={canPreview ? handlePreview : undefined}
        pendingText={
          isArtifactPublisher
            ? "Publishing presentation..."
            : "Generating presentation..."
        }
        thumbnailUrl={resolvePublishedPresentationThumbnailUrl({
          artifactPreview: effectiveRecord,
          previewImageUrl: artifact?.previewImageUrl,
        })}
        title={title}
      />
    </div>
  );
}
