"use client";

import { FileCode2, File, ExternalLink, Loader2 } from "lucide-react";
import {
  artifactRenderHost,
  type ArtifactBlockProps,
} from "@sourceweft/contracts/artifact-ui";
import { PublishedPresentationArtifactBlock } from "./artifact-block";

/** The old pptx render token stays registered, but it no longer dictates type. */
export function PublishedArtifactBlock(props: ArtifactBlockProps) {
  const host = artifactRenderHost();
  const type =
    host.readToolOutputField(props.toolCall?.output, "artifactType") ??
    props.toolCall?.input.artifactType;
  if (!type || type === "slides")
    return <PublishedPresentationArtifactBlock {...props} />;
  return <StoredFileArtifactBlock {...props} />;
}

function StoredFileArtifactBlock({
  toolCall,
  workspaceId,
  onArtifactPreview,
}: ArtifactBlockProps) {
  const host = artifactRenderHost();
  const result = host.useArtifactSnapshot({
    toolCallOutput: toolCall?.output,
    workspaceId,
    enabled: toolCall?.status === "completed",
  });
  const title =
    host.readToolOutputField(toolCall?.output, "title") ??
    String(toolCall?.input.title ?? "Artifact");
  const type =
    host.readToolOutputField(toolCall?.output, "artifactType") ??
    toolCall?.input.artifactType;
  const fileName = host.readToolOutputField(toolCall?.output, "fileName");
  const href = host.readToolOutputField(toolCall?.output, "artifactUrl");
  const ready =
    toolCall?.status === "completed" &&
    host.readToolOutputField(toolCall.output, "status") === "ready";
  const Icon = type === "html" ? FileCode2 : File;
  const files = result.snapshot?.payloadJson.versionFiles;
  const cover = Array.isArray(files)
    ? files.find(
        (file) =>
          file &&
          typeof file === "object" &&
          file.role === "preview" &&
          typeof file.url === "string",
      )
    : null;
  if (toolCall?.status === "error")
    return (
      <p role="alert" className="text-sm text-destructive">
        {toolCall.error ?? "Artifact publication failed"}
      </p>
    );
  return (
    <div className="my-2 flex items-center gap-3 rounded-xl border bg-background p-4">
      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
        {cover ? (
          <img
            src={cover.url}
            alt=""
            className="size-10 rounded-lg object-cover"
          />
        ) : (
          <Icon className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {ready ? fileName : "Publishing artifact…"}
        </p>
      </div>
      {!ready ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : result.snapshot && onArtifactPreview ? (
        <button
          className="rounded-md px-3 py-2 text-xs font-medium hover:bg-muted"
          type="button"
          onClick={() => onArtifactPreview(result.snapshot!)}
        >
          Preview
        </button>
      ) : (
        href && (
          <a
            className="flex items-center gap-1 rounded-md px-3 py-2 text-xs font-medium hover:bg-muted"
            href={href}
          >
            Open
            <ExternalLink className="size-3" />
          </a>
        )
      )}
    </div>
  );
}
