import { useMemo } from "react";
import { z } from "zod";
import type { ArtifactRecordsTransport } from "@sourceweft/contracts/artifact-records";
import {
  artifactRenderHost,
  type ArtifactPreviewContext,
  type ArtifactPreviewResult,
} from "@sourceweft/contracts/artifact-ui";
import {
  HTML_ARTIFACT_TYPE,
  htmlArtifactPayloadSchema,
  htmlArtifactRecordCapabilities,
} from "@sourceweft/contracts/html-artifact";
import { DEFAULT_ARTIFACT_STORAGE_TEXT } from "@sourceweft/contracts/artifact-storage-text";
import { HtmlPreview, type HtmlPreviewFile } from "./html-preview";

const useDefaultStorageText = () => DEFAULT_ARTIFACT_STORAGE_TEXT;

/**
 * The host's translated prompts, or the English defaults where none is
 * installed (an unconfigured host throws). The choice is fixed for the life of
 * the app, so the same hook runs on every render.
 */
function storageTextHook() {
  try {
    return artifactRenderHost().useArtifactStorageText ?? useDefaultStorageText;
  } catch {
    return useDefaultStorageText;
  }
}

const fileProjectionSchema = z.array(
  z.object({
    fileName: z.string(),
    role: z.string(),
    url: z.string().nullable(),
    downloadUrl: z.string().nullable().optional(),
    access: z.enum(["artifact", "private"]).optional(),
    byteLength: z.number().int().positive().optional(),
  }),
);

/** The exact version this preview renders: payload first, then the file URL. */
function renderedVersionId(payload: Record<string, unknown>, fileUrl: string) {
  if (typeof payload.versionId === "string" && payload.versionId)
    return payload.versionId;
  try {
    return new URL(fileUrl, "http://host.invalid").searchParams.get(
      "artifactVersionId",
    );
  } catch {
    return null;
  }
}

function appRecordsTransport(input: {
  workspaceId: string | null | undefined;
  artifactId: string;
  artifactVersionId: string | null;
}): ArtifactRecordsTransport | null {
  if (!input.workspaceId || !input.artifactVersionId) return null;
  let create;
  try {
    create = artifactRenderHost().createArtifactRecordsTransport;
  } catch {
    return null;
  }
  return (
    create?.({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      artifactVersionId: input.artifactVersionId,
    }) ?? null
  );
}

function HtmlArtifactPreviewContent({
  context,
  fileUrl,
  downloadUrl,
  files,
  payload,
}: {
  context: ArtifactPreviewContext;
  fileUrl: string;
  downloadUrl: string | null;
  files: readonly HtmlPreviewFile[];
  payload: z.infer<typeof htmlArtifactPayloadSchema>;
}) {
  const useStorageText = storageTextHook();
  const hostText = useStorageText();
  const text = context.storageText ?? hostText;
  const storage = htmlArtifactRecordCapabilities(payload);
  const isShare = context.surface === "share";
  const versionId = renderedVersionId(context.payload, fileUrl);
  const workspaceId = context.workspaceId ?? context.artifact.workspaceId;
  // A stable transport keeps the iframe's bridge (and its port) alive across
  // re-renders; it changes only when the rendered version does.
  const appRecords = useMemo(
    () =>
      isShare || !storage.storage
        ? null
        : appRecordsTransport({
            workspaceId,
            artifactId: context.artifact.id,
            artifactVersionId: versionId,
          }),
    [isShare, storage.storage, workspaceId, context.artifact.id, versionId],
  );
  return (
    <HtmlPreview
      key={fileUrl}
      fileUrl={fileUrl}
      downloadUrl={downloadUrl}
      title={context.title}
      presentation={payload.metadata.presentation}
      files={files}
      storage={storage}
      records={isShare ? (context.records ?? null) : appRecords}
      text={text}
    />
  );
}

export function htmlArtifactPreview(
  context: ArtifactPreviewContext,
): ArtifactPreviewResult | null {
  if (context.artifact.artifactType !== HTML_ARTIFACT_TYPE) return null;
  if (context.artifact.status !== "ready")
    return {
      id: "html-document",
      content: (
        <p className="p-5 text-sm text-muted-foreground">
          {context.artifact.errorMessage ??
            "Preparing HTML. The document will run after publication."}
        </p>
      ),
    };
  const parsed = htmlArtifactPayloadSchema.safeParse(context.payload);
  const files = fileProjectionSchema.safeParse(context.payload.versionFiles);
  if (!parsed.success || !files.success)
    return {
      id: "html-document",
      content: (
        <p role="alert" className="p-5 text-sm text-destructive">
          This HTML version has no valid file projection. Reload the artifact.
        </p>
      ),
    };
  const primary = files.data.find((file) => file.role === "primary");
  if (!primary?.url)
    return {
      id: "html-document",
      content: (
        <p role="alert" className="p-5 text-sm">
          The published HTML file is unavailable.
        </p>
      ),
    };
  return {
    id: "html-document",
    blocksDefaultDownload: true,
    blocksDefaultFullscreen: true,
    content: (
      <HtmlArtifactPreviewContent
        key={primary.url}
        context={context}
        fileUrl={primary.url}
        downloadUrl={primary.downloadUrl ?? null}
        files={files.data}
        payload={parsed.data}
      />
    ),
  };
}
