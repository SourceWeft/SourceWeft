import {
  ARTIFACT_MIME_TYPES,
  isInlinePreviewableMimeType,
} from "@sourceweft/builtin-tool-publish-artifact";
import { requireContentWorkspace } from "../workspace/guards";
import { ContentError } from "../content/errors";
import { downloadArtifactObject } from "../sources/storage";
import {
  sanitizeArtifactDownloadFileBaseName,
  withFileExtension,
} from "./filenames";
import {
  findArtifactRecord,
  listArtifactRecords,
} from "./repository";

const VISUAL_HTML_DECK_RENDERER = "visual_html_deck";

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveArtifactFileName(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  const payload = toObjectRecord(artifact?.payloadJson);
  const fileName =
    payload && typeof payload.fileName === "string"
      ? payload.fileName.trim()
      : "";
  const generationMode =
    payload && typeof payload.generationMode === "string"
      ? payload.generationMode.trim()
      : "";
  if (artifact?.artifactType === "slides") {
    if (generationMode === "visual_html" && fileName) {
      return fileName;
    }
    const title = artifact.title?.trim();
    if (title) {
      return withFileExtension(
        sanitizeArtifactDownloadFileBaseName(title, "generated-presentation"),
        generationMode === "visual_html" ? ".html" : ".pptx",
      );
    }
  }

  if (fileName) {
    return fileName;
  }

  const title = artifact?.title?.trim() || "artifact";
  const extension =
    artifact?.artifactType === "image"
      ? ".png"
      : "";
  return `${title}${extension}`;
}

function resolveArtifactContentType(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  const payload = toObjectRecord(artifact?.payloadJson);
  const mimeType =
    payload && typeof payload.mimeType === "string"
      ? payload.mimeType.trim()
      : "";
  if (mimeType) {
    return mimeType;
  }

  return artifact?.artifactType === "image"
    ? ARTIFACT_MIME_TYPES.png
    : ARTIFACT_MIME_TYPES.binary;
}

function isInlinePreviewableContentType(contentType: string) {
  return isInlinePreviewableMimeType(contentType);
}

function resolveArtifactRenderer(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  const payload = toObjectRecord(artifact?.payloadJson);
  const generationMode =
    payload && typeof payload.generationMode === "string"
      ? payload.generationMode.trim()
      : "";
  return artifact?.artifactType === "slides" && generationMode === "visual_html"
    ? VISUAL_HTML_DECK_RENDERER
    : null;
}

function hasArtifactPreviewFile(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  if (!artifact || !artifact.storageKey || artifact.status !== "ready") {
    return false;
  }

  if (artifact.artifactType === "slides" || artifact.artifactType === "image") {
    return true;
  }

  if (artifact.artifactType === "file") {
    return isInlinePreviewableContentType(resolveArtifactContentType(artifact));
  }

  return false;
}

function buildArtifactCapabilities(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  const hasFile = Boolean(
    artifact?.status === "ready" &&
      artifact.storageKey,
  );
  return {
    canOpenFile: hasFile,
    canDownloadFile: hasFile,
    canPreviewInline: hasArtifactPreviewFile(artifact),
    canRenderClientVideo: Boolean(
      artifact &&
        artifact.artifactType === "video_presentation" &&
        artifact.status !== "failed",
    ),
  };
}

function resolveSourceJsonFileName(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  const payload = toObjectRecord(artifact?.payloadJson);
  const fileName =
    payload && typeof payload.sourceJsonFileName === "string"
      ? payload.sourceJsonFileName.trim()
      : "";
  return fileName || "deck.source.json";
}

function resolveSourceJsonStorageBucket(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  const payload = toObjectRecord(artifact?.payloadJson);
  const bucket =
    payload && typeof payload.sourceJsonStorageBucket === "string"
      ? payload.sourceJsonStorageBucket.trim()
      : "";
  return bucket || artifact?.storageBucket;
}

function resolveArtifactAsset(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
  fileName: string,
) {
  const decodedFileName = decodeURIComponent(fileName).trim();
  if (!decodedFileName || !artifact) {
    return null;
  }
  const payload = toObjectRecord(artifact.payloadJson);
  if (!payload) {
    return null;
  }

  const html = toObjectRecord(payload.html);
  if (
    html &&
    typeof html.fileName === "string" &&
    html.fileName === decodedFileName &&
    artifact.storageKey
  ) {
    return {
      contentType:
        typeof payload.mimeType === "string"
          ? payload.mimeType
          : ARTIFACT_MIME_TYPES.binary,
      fileName: decodedFileName,
      storageBucket: artifact.storageBucket,
      storageKey: artifact.storageKey,
    };
  }

  return null;
}

function resolveArtifactPreviewImage(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  if (
    !artifact ||
    artifact.status !== "ready" ||
    artifact.artifactType !== "slides"
  ) {
    return null;
  }
  const storageKey =
    typeof artifact.previewStorageKey === "string"
      ? artifact.previewStorageKey.trim()
      : "";
  if (!storageKey) {
    return null;
  }
  const metadata = toObjectRecord(artifact.previewMetadataJson);
  const mimeType =
    typeof metadata?.mimeType === "string"
      ? metadata.mimeType.trim()
      : "";
  const fileName =
    typeof metadata?.fileName === "string" &&
    metadata.fileName.trim().length > 0
      ? metadata.fileName.trim()
      : "preview.jpg";
  return {
    contentType: mimeType || ARTIFACT_MIME_TYPES.jpeg,
    fileName,
    storageBucket: artifact.storageBucket,
    storageKey,
  };
}

function decodeArtifactCursor(cursor: string | undefined) {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") {
      return null;
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export class ContentArtifactsService {
  private buildArtifactResponse(input: {
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>;
    workspaceId: string;
  }) {
    const { artifact, workspaceId } = input;
    return {
      id: artifact.id,
      teamId: artifact.teamId,
      workspaceId: artifact.workspaceId,
      threadId: artifact.threadId,
      artifactType: artifact.artifactType,
      status: artifact.status,
      title: artifact.title,
      promptText: artifact.promptText,
      payloadJson: artifact.payloadJson,
      storageBucket: artifact.storageBucket,
      storageKey: artifact.storageKey,
      previewStorageKey: artifact.previewStorageKey,
      previewMetadataJson: artifact.previewMetadataJson,
      errorCode: artifact.errorCode,
      errorMessage: artifact.errorMessage,
      createdBy: artifact.createdBy,
      completedAt: artifact.completedAt,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      previewUrl: hasArtifactPreviewFile(artifact)
        ? this.buildArtifactPreviewUrl({
            workspaceId,
            artifactId: artifact.id,
          })
        : null,
      capabilities: buildArtifactCapabilities(artifact),
    };
  }

  async listArtifacts(input: {
    cursor?: string;
    workspaceId: string;
    userId: string;
    limit?: number;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const artifacts = await listArtifactRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      cursor: decodeArtifactCursor(input.cursor),
      limit: input.limit,
    });

    return {
      items: artifacts.items.map((artifact) =>
        this.buildArtifactResponse({
          artifact,
          workspaceId: workspace.id,
        }),
      ),
      nextCursor: artifacts.nextCursor,
    };
  }

  async getArtifact(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const artifact = await findArtifactRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      artifactId: input.artifactId,
    });

    if (!artifact) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }

    return {
      artifact: this.buildArtifactResponse({
        artifact,
        workspaceId: workspace.id,
      }),
    };
  }

  buildArtifactPreviewUrl(input: { workspaceId: string; artifactId: string }) {
    const params = new URLSearchParams({
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
    });
    return `/artifact-preview?${params.toString()}`;
  }

  async getArtifactFile(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const artifact = await findArtifactRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      artifactId: input.artifactId,
    });

    if (!artifact) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }
    if (!artifact.storageKey) {
      throw new ContentError(
        400,
        "ARTIFACT_FILE_MISSING",
        "Artifact has no stored file",
      );
    }

    return {
      body: await downloadArtifactObject({
        bucket: artifact.storageBucket,
        key: artifact.storageKey,
      }),
      contentType: resolveArtifactContentType(artifact),
      fileName: resolveArtifactFileName(artifact),
      renderer: resolveArtifactRenderer(artifact),
    };
  }

  async getArtifactSourceJson(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const artifact = await findArtifactRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      artifactId: input.artifactId,
    });

    if (!artifact) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }

    const payload = toObjectRecord(artifact.payloadJson);
    const sourceJsonStorageKey =
      payload && typeof payload.sourceJsonStorageKey === "string"
        ? payload.sourceJsonStorageKey.trim()
        : "";

    if (sourceJsonStorageKey) {
      return {
        body: await downloadArtifactObject({
          bucket: resolveSourceJsonStorageBucket(artifact),
          key: sourceJsonStorageKey,
        }),
        contentType: "application/json",
        fileName: resolveSourceJsonFileName(artifact),
      };
    }

    if (
      payload &&
      "sourceJson" in payload &&
      payload.sourceJson !== undefined
    ) {
      return {
        body: Buffer.from(JSON.stringify(payload.sourceJson, null, 2), "utf8"),
        contentType: "application/json",
        fileName: resolveSourceJsonFileName(artifact),
      };
    }

    throw new ContentError(
      404,
      "ARTIFACT_SOURCE_JSON_MISSING",
      "Artifact has no stored source JSON",
    );
  }

  async getArtifactPreviewImage(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const artifact = await findArtifactRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      artifactId: input.artifactId,
    });

    if (!artifact) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }
    const previewImage = resolveArtifactPreviewImage(artifact);
    if (!previewImage) {
      throw new ContentError(
        404,
        "ARTIFACT_PREVIEW_IMAGE_NOT_FOUND",
        "Artifact preview image not found",
      );
    }

    return {
      body: await downloadArtifactObject({
        bucket: previewImage.storageBucket,
        key: previewImage.storageKey,
      }),
      contentType: previewImage.contentType,
      fileName: previewImage.fileName,
    };
  }

  async getArtifactAsset(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    fileName: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const artifact = await findArtifactRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      artifactId: input.artifactId,
    });

    if (!artifact) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }
    const asset = resolveArtifactAsset(artifact, input.fileName);
    if (!asset) {
      throw new ContentError(
        404,
        "ARTIFACT_ASSET_NOT_FOUND",
        "Artifact asset not found",
      );
    }

    return {
      body: await downloadArtifactObject({
        bucket: asset.storageBucket,
        key: asset.storageKey,
      }),
      contentType: asset.contentType,
      fileName: asset.fileName,
    };
  }
}

export const contentArtifactsService = new ContentArtifactsService();

export const testExports = {
  hasArtifactPreviewFile,
  isInlinePreviewableContentType,
  buildArtifactCapabilities,
  resolveArtifactAsset,
  resolveArtifactPreviewImage,
  resolveArtifactContentType,
  resolveArtifactFileName,
  resolveArtifactRenderer,
};
