import { HTML_ARTIFACT_TYPE } from "@sourceweft/contracts/html-artifact";
import { extensionForPath, fileNameForTitle } from "../artifact-files";
import { ArtifactPublishError } from "../schemas";
import type { ArtifactTypeHandler } from "../artifact-type-handlers";
import { validateHtmlBytes } from "./validation";

export const htmlTypeHandler: ArtifactTypeHandler = {
  artifactType: HTML_ARTIFACT_TYPE,
  prepare({ source, publishInput }) {
    if (![".html", ".htm"].includes(extensionForPath(source.path))) {
      throw new ArtifactPublishError(
        "HTML_DOCUMENT_INVALID",
        "HTML source must use .html or .htm",
      );
    }
    const mime = source.mimeType?.split(";")[0]?.trim().toLowerCase();
    if (mime && !["text/html", "application/octet-stream"].includes(mime)) {
      throw new ArtifactPublishError(
        "HTML_DOCUMENT_INVALID",
        "HTML source MIME must be text/html",
      );
    }
    const validated = validateHtmlBytes(source.bytes);
    const fileName = fileNameForTitle({
      title: publishInput.title,
      extension: ".html",
    });
    return {
      immutableFileUrls: true,
      contentAddressedRequests: true,
      requiredAssets:
        validated.metadata.presentation?.pages.flatMap((page) =>
          page.thumbnail ? [page.thumbnail] : [],
        ) ?? [],
      artifactType: "html",
      byteLength: source.bytes.byteLength,
      contentType: "text/html; charset=utf-8",
      fileName,
      payload: {
        schemaVersion: 1,
        fileName,
        mimeType: "text/html",
        byteLength: source.bytes.byteLength,
        ...validated,
      },
      toOutput: ({ artifactId, reused, artifactUrl, downloadUrl, title }) => ({
        ok: true,
        type: "html_artifact_result",
        status: "ready",
        reused,
        artifactId,
        artifact_id: artifactId,
        artifactType: "html",
        title,
        fileName,
        file_name: fileName,
        mimeType: "text/html",
        mime_type: "text/html",
        byteLength: source.bytes.byteLength,
        byte_length: source.bytes.byteLength,
        artifactUrl,
        artifact_url: artifactUrl,
        downloadUrl,
        download_url: downloadUrl,
        contentDigest: validated.contentDigest,
      }),
    };
  },
};
