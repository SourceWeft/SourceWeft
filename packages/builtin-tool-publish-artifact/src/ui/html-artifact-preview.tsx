import { z } from "zod";
import type {
  ArtifactPreviewContext,
  ArtifactPreviewResult,
} from "@sourceweft/contracts/artifact-ui";
import {
  HTML_ARTIFACT_TYPE,
  htmlArtifactPayloadSchema,
} from "@sourceweft/contracts/html-artifact";
import { HtmlPreview } from "./html-preview";

const fileProjectionSchema = z.array(
  z.object({
    fileName: z.string(),
    role: z.string(),
    url: z.string().nullable(),
    downloadUrl: z.string().nullable().optional(),
  }),
);

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
      <HtmlPreview
        key={primary.url}
        fileUrl={primary.url}
        downloadUrl={primary.downloadUrl ?? null}
        title={context.title}
        presentation={parsed.data.metadata.presentation}
        files={files.data}
      />
    ),
  };
}
