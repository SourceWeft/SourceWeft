"use client";

/**
 * `generate_video_presentation`'s card in the message stream.
 *
 * The card is statically *this* capability's, so there is no "is this a video?"
 * question left to ask anywhere in it: the stage words come from this package's
 * presentation, the progress from this package's artifact protocol, and the
 * primary action is always "open the preview" because a video presentation is
 * never a downloadable file. The shell it renders into is capability-neutral
 * and lives in `@sourceweft/ui-web`.
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
import { videoPresentationArtifactProtocol } from "../artifact-protocol";
import {
  buildVideoPresentationPreviewRecord,
  getVideoPresentationPayloadStageWords,
  getVideoPresentationStageWords,
  getVideoPresentationToolCallBrief,
  getVideoPresentationToolCallTitle,
  resolveVideoPresentationArtifactRef,
} from "./artifact-view";

const MODE_LABEL = "Video presentation";

/**
 * The row the preview panel receives, with anything the live artifact snapshot
 * already knows preferred over what the tool output guessed.
 */
function withSnapshot(
  record: ArtifactPreviewRecord | null,
  snapshot: ArtifactStatusSnapshot | undefined,
  status: ArtifactPreviewRecord["status"],
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
      status === "ready"
        ? (snapshot.completedAt ?? record.completedAt ?? new Date().toISOString())
        : record.completedAt,
    updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
  };
}

export function VideoPresentationArtifactBlock({
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

  const artifact = resolveVideoPresentationArtifactRef({
    output: toolCall.output,
    readField: (key) => host.readToolOutputField(toolCall.output, key),
  });
  const pageUrl = artifact
    ? host.resolveArtifactPageUrl({
        artifactId: artifact.artifactId,
        fallbackUrl: artifact.artifactUrl,
        workspaceId,
      })
    : null;
  const title =
    artifact?.title ||
    getVideoPresentationToolCallTitle(toolCall) ||
    "Generated video presentation";
  const description = getVideoPresentationToolCallBrief(toolCall);
  const artifactSnapshot = artifact?.artifactId
    ? effectiveStatuses?.get(artifact.artifactId)
    : undefined;
  const generationStatus = videoPresentationArtifactProtocol.resolveProgressView(
    {
      artifactSnapshot: artifactSnapshot ?? null,
      toolCallOutput: toolCall.output,
      toolCallStatus: toolCall.status,
    },
  ).status;
  const previewRecord = artifact
    ? buildVideoPresentationPreviewRecord({
        artifactId: artifact.artifactId,
        description,
        previewUrl:
          pageUrl ??
          (artifact.artifactId && workspaceId
            ? host.resolveArtifactPageUrl({
                artifactId: artifact.artifactId,
                workspaceId,
              })
            : null),
        status: artifact.status,
        title,
        workspaceId,
      })
    : null;

  const isInFlight =
    toolCall.status === "running" ||
    toolCall.status === "approval_requested" ||
    toolCall.status === "error";
  if (!isInFlight && !previewRecord) {
    return null;
  }

  if (toolCall.status === "error") {
    return (
      <ArtifactBlockError
        message={toolCall.error ?? "Video presentation generation failed."}
      />
    );
  }

  const effectiveRecord = withSnapshot(
    previewRecord,
    artifactSnapshot,
    generationStatus,
  );
  const isPending =
    toolCall.status === "running" ||
    toolCall.status === "approval_requested" ||
    generationStatus === "pending" ||
    generationStatus === "running";
  const isError = generationStatus === "failed";
  const canPreview =
    Boolean(effectiveRecord && onArtifactPreview) && !isPending && !isError;
  const stageWords = getVideoPresentationPayloadStageWords(
    artifactSnapshot?.payloadJson ?? previewRecord?.payloadJson,
  );
  const sourceJsonUrl = artifact?.sourceJsonUrl
    ? host.resolveApiAssetUrl(artifact.sourceJsonUrl)
    : null;
  const badges: ArtifactCardBadge[] = [{ label: MODE_LABEL }];
  if (sourceJsonUrl && !isPending && !isError) {
    badges.push({ href: sourceJsonUrl, label: "Source JSON" });
  }
  const handlePreview = () => {
    if (effectiveRecord && onArtifactPreview && canPreview) {
      onArtifactPreview(effectiveRecord);
    }
  };

  return (
    <div className="space-y-3">
      <ArtifactCard
        action={{
          disabled: isPending || isError || !canPreview,
          icon: <Download className="size-3.5" />,
          label: "Open Video",
          onClick: handlePreview,
          title: "Open video presentation",
        }}
        badges={badges}
        description={description}
        errorText={
          stageWords ??
          getVideoPresentationStageWords("failed") ??
          "Generation failed."
        }
        fallbackIcon={<Presentation className="size-5 text-foreground/80" />}
        isError={isError}
        isPending={isPending}
        onActivate={canPreview ? handlePreview : undefined}
        pendingText={
          stageWords ??
          getVideoPresentationStageWords("preparing") ??
          "Preparing..."
        }
        thumbnailUrl={host.resolveArtifactPreviewImageUrl({
          artifactId: effectiveRecord?.id,
          previewMetadataJson: effectiveRecord?.previewMetadataJson,
          previewStorageKey: effectiveRecord?.previewStorageKey,
          workspaceId: effectiveRecord?.workspaceId,
        })}
        title={title}
      />
    </div>
  );
}
