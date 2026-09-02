"use client";

import { ExternalLink, File, ImageIcon, Presentation } from "lucide-react";
import { artifactRenderHost } from "@sourceweft/agent-tool-registry/ui";
import { ArtifactCard } from "@sourceweft/ui-web/components/artifact-block/artifact-card";
import type {
  ArtifactPreviewRecord,
  ArtifactStatusSnapshot,
  MessageRenderBlock,
} from "./types";
import { isArtifactSnapshotTerminal } from "./artifact-work-state";
import { useArtifactSnapshot } from "./use-artifact-snapshot";
import { useArtifactVersionMedia } from "./use-artifact-version-media";

type ArtifactOutputBlock = Extract<
  MessageRenderBlock,
  { type: "artifact_output" }
>;

function artifactIcon(type: string) {
  if (type === "image" || type === "infographic") {
    return <ImageIcon className="size-5 text-foreground/80" />;
  }
  if (type === "slides" || type === "video_presentation") {
    return <Presentation className="size-5 text-foreground/80" />;
  }
  return <File className="size-5 text-foreground/80" />;
}

function toPreviewRecord(
  snapshot: ArtifactStatusSnapshot,
): ArtifactPreviewRecord {
  return { ...snapshot };
}

export function ArtifactOutputCard({
  artifactStatuses,
  block,
  onArtifactPreview,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  block: ArtifactOutputBlock;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  workspaceId?: string | null;
}) {
  const host = artifactRenderHost();
  const parentSnapshot = artifactStatuses?.get(block.artifactId);
  // This card only ever renders for a COMMITTED artifact_output block, so the
  // artifact is already ready server-side by construction. A parent snapshot
  // can still be a stale non-terminal ("running") cache, though: the status
  // hooks that populate `artifactStatuses` fetch it once per artifact-id set
  // and never revisit an id once it drops out of the pending set (which
  // happens the instant the tool call commits). Only skip this card's own
  // one-shot fetch when the parent snapshot is actually terminal — otherwise
  // a stale "running" entry permanently suppresses the refresh that would
  // correct it, and the card is stuck showing "Artifact unavailable" for the
  // rest of the session.
  const { error, snapshot } = useArtifactSnapshot({
    artifactSnapshot: parentSnapshot,
    enabled: !parentSnapshot || !isArtifactSnapshotTerminal(parentSnapshot),
    toolCallOutput: { artifact_id: block.artifactId },
    workspaceId,
  });
  const exactVersion = useArtifactVersionMedia({
    workspaceId,
    artifactId: block.artifactId,
    artifactVersionId: block.artifactVersionId,
    enabled: snapshot?.artifactType === "video_presentation",
  });
  const exactVideoSnapshot =
    snapshot?.artifactType === "video_presentation" && exactVersion.media
      ? {
          ...snapshot,
          artifactVersionId: block.artifactVersionId,
          title: exactVersion.media.title,
          promptText: exactVersion.media.description,
          payloadJson: exactVersion.media,
          previewMetadataJson: {},
          previewStorageKey: null,
          previewUrl: exactVersion.media.coverImage?.url ?? null,
          storageBucket: null,
          storageKey: null,
          capabilities: {
            canDownloadFile: true,
            canOpenFile: true,
            canPreviewInline: true,
            canRenderClientSide: true,
          },
        }
      : null;
  const effectiveSnapshot =
    snapshot?.artifactType === "video_presentation"
      ? exactVideoSnapshot
      : snapshot;
  const effectiveError =
    error ??
    (snapshot?.artifactType === "video_presentation"
      ? exactVersion.error
      : null);

  if (effectiveError || (snapshot && snapshot.status !== "ready")) {
    return (
      <div className="max-w-xl rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground/80">Artifact unavailable</p>
        <p className="mt-0.5 text-xs">
          {effectiveError ??
            snapshot?.errorMessage ??
            "The published artifact is no longer available."}
        </p>
      </div>
    );
  }

  if (!effectiveSnapshot) {
    return (
      <ArtifactCard
        action={{
          disabled: true,
          icon: <ExternalLink className="size-3.5" />,
          label: "Open",
          onClick: () => {},
        }}
        badges={[{ label: "Published artifact" }]}
        fallbackIcon={<File className="size-5 text-muted-foreground" />}
        title="Loading published artifact…"
      />
    );
  }

  const record = toPreviewRecord(effectiveSnapshot);
  const canPreview = Boolean(onArtifactPreview);
  const handlePreview = () => {
    if (canPreview) {
      onArtifactPreview?.(record);
    }
  };
  const previewImageUrl =
    (snapshot?.artifactType === "video_presentation"
      ? (exactVersion.media?.coverImage?.url ?? null)
      : host.resolveArtifactPreviewImageUrl({
          artifactId: effectiveSnapshot.id,
          previewMetadataJson: effectiveSnapshot.previewMetadataJson,
          previewStorageKey: effectiveSnapshot.previewStorageKey,
          workspaceId: effectiveSnapshot.workspaceId,
        })) ??
    (effectiveSnapshot.artifactType === "image" && effectiveSnapshot.storageKey
      ? host.resolveArtifactFileUrl({
          artifactId: effectiveSnapshot.id,
          workspaceId: effectiveSnapshot.workspaceId,
        })
      : null);

  return (
    <ArtifactCard
      action={{
        disabled: !canPreview,
        icon: <ExternalLink className="size-3.5" />,
        label: "Open",
        onClick: handlePreview,
        title: "Open artifact",
      }}
      badges={[
        { label: effectiveSnapshot.artifactType.replaceAll("_", " ") },
        ...(block.producer.kind === "subagent"
          ? [{ label: block.producer.subagentType ?? "Sub-agent" }]
          : []),
      ]}
      description={effectiveSnapshot.promptText}
      fallbackIcon={artifactIcon(effectiveSnapshot.artifactType)}
      onActivate={canPreview ? handlePreview : undefined}
      thumbnailUrl={previewImageUrl}
      title={effectiveSnapshot.title ?? "Published artifact"}
    />
  );
}
