import { createHash } from "node:crypto";
import type { ArtifactResource } from "@sourceweft/contracts/artifact-urls";
import {
  parseArtifactVersionFiles,
  artifactFileNameSchema,
  type ArtifactVersionFile,
} from "@sourceweft/contracts/artifact-version-files";
import { ContentError } from "../content/errors";

export function resolveArtifactVersionFile(input: {
  filesJson: unknown;
  workspaceId: string;
  artifactId: string;
  resource: ArtifactResource;
}): ArtifactVersionFile {
  const manifest = parseArtifactVersionFiles(input.filesJson);
  const resource = input.resource;
  const file = manifest?.files.find((item) => {
    if (item.access !== "artifact" || item.role === "source") return false;
    switch (resource.kind) {
      case "file":
      case "download":
        return item.role === "primary";
      case "previewImage":
        return item.role === "preview";
      case "asset":
        return item.fileName === resource.fileName;
      case "sourceJson":
        return false;
    }
  });
  if (
    !file ||
    !file.storageKey.startsWith(
      `workspaces/${input.workspaceId}/artifacts/${input.artifactId}/`,
    )
  ) {
    throw new ContentError(
      404,
      "ARTIFACT_VERSION_FILE_NOT_FOUND",
      "This version has no authorized file for this request",
    );
  }
  return file;
}

/** Internal authoring reader only. Never use this selector on HTTP/share routes. */
export function resolveArtifactVersionAttachment(input: {
  filesJson: unknown;
  workspaceId: string;
  artifactId: string;
  fileName: string;
}): ArtifactVersionFile {
  const name = artifactFileNameSchema.safeParse(input.fileName);
  const manifest = parseArtifactVersionFiles(input.filesJson);
  const file = name.success
    ? manifest?.files.find((item) => item.fileName === name.data)
    : undefined;
  if (
    !file ||
    !file.storageKey.startsWith(
      `workspaces/${input.workspaceId}/artifacts/${input.artifactId}/`,
    )
  ) {
    throw new ContentError(
      404,
      "ARTIFACT_VERSION_FILE_NOT_FOUND",
      "This version has no authorized file for this request",
    );
  }
  return file;
}

export async function readArtifactVersionFile(
  file: ArtifactVersionFile,
  download: (input: {
    bucket: string | null;
    key: string;
  }) => Promise<Uint8Array>,
) {
  const body = await download({
    bucket: file.storageBucket,
    key: file.storageKey,
  });
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (body.byteLength !== file.byteLength || digest !== file.contentDigest) {
    throw new ContentError(
      409,
      "ARTIFACT_FILE_INTEGRITY_MISMATCH",
      "The stored file does not match its published version",
    );
  }
  return {
    body: Buffer.from(body),
    contentType: file.contentType,
    fileName: file.fileName,
  };
}

export function projectArtifactVersionFiles(input: {
  filesJson: unknown;
  url: (resource: ArtifactResource) => string | null;
}) {
  const files = parseArtifactVersionFiles(input.filesJson);
  if (!files) return null;
  return files.files
    .filter((file) => file.access === "artifact" && file.role !== "source")
    .map((file) => {
      const resource: ArtifactResource =
        file.role === "primary"
          ? { kind: "file" }
          : file.role === "preview"
            ? { kind: "previewImage" }
            : { kind: "asset", fileName: file.fileName };
      return {
        fileName: file.fileName,
        contentType: file.contentType,
        byteLength: file.byteLength,
        contentDigest: file.contentDigest,
        role: file.role,
        url: input.url(resource),
        ...(file.role === "primary"
          ? { downloadUrl: input.url({ kind: "download" }) }
          : file.role === "asset"
            ? {
                downloadUrl: input.url({
                  kind: "asset",
                  fileName: file.fileName,
                  download: true,
                }),
              }
            : {}),
      };
    });
}
