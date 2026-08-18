"use client";

import { ExternalLink, File, ImageIcon, Presentation } from "lucide-react";
import { artifactRenderHost } from "@sourceweft/agent-tool-registry/ui";
import { ArtifactCard } from "@sourceweft/ui-web/components/artifact-block/artifact-card";
import type {
  ArtifactPreviewRecord,
  ArtifactStatusSnapshot,
  MessageRenderBlock,
} from "./types";
import { useArtifactSnapshot } from "./use-artifact-snapshot";

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

function toPreviewRecord(snapshot: ArtifactStatusSnapshot): ArtifactPreviewRecord {
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
  const { error, snapshot } = useArtifactSnapshot({
    artifactSnapshot: parentSnapshot,
    enabled: !parentSnapshot,
    toolCallOutput: { artifact_id: block.artifactId },
    workspaceId,
  });

  if (error || (snapshot && snapshot.status !== "ready")) {
    return (
      <div className="max-w-xl rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground/80">Artifact unavailable</p>
        <p className="mt-0.5 text-xs">
          {error ?? snapshot?.errorMessage ?? "The published artifact is no longer available."}
        </p>
      </div>
    );
  }

  if (!snapshot) {
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

  const record = toPreviewRecord(snapshot);
  const canPreview = Boolean(onArtifactPreview);
  const handlePreview = () => {
    if (canPreview) {
      onArtifactPreview?.(record);
    }
  };
  const previewImageUrl =
    host.resolveArtifactPreviewImageUrl({
      artifactId: snapshot.id,
      previewMetadataJson: snapshot.previewMetadataJson,
      previewStorageKey: snapshot.previewStorageKey,
      workspaceId: snapshot.workspaceId,
    }) ??
    (snapshot.artifactType === "image" && snapshot.storageKey
      ? host.resolveArtifactFileUrl({
          artifactId: snapshot.id,
          workspaceId: snapshot.workspaceId,
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
        { label: snapshot.artifactType.replaceAll("_", " ") },
        ...(block.producer.kind === "subagent"
          ? [{ label: block.producer.subagentType ?? "Sub-agent" }]
          : []),
      ]}
      description={snapshot.promptText}
      fallbackIcon={artifactIcon(snapshot.artifactType)}
      onActivate={canPreview ? handlePreview : undefined}
      thumbnailUrl={previewImageUrl}
      title={snapshot.title ?? "Published artifact"}
    />
  );
}
