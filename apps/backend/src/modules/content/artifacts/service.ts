import { requireContentWorkspace } from "../content-support";
import { ContentError } from "../errors";
import { downloadArtifactObject } from "../storage";
import { findArtifactRecord, listArtifactRecords } from "./repository";

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveArtifactFileName(artifact: Awaited<ReturnType<typeof findArtifactRecord>>) {
  const payload = toObjectRecord(artifact?.payloadJson);
  const fileName =
    payload && typeof payload.fileName === "string"
      ? payload.fileName.trim()
      : "";
  if (fileName) {
    return fileName;
  }

  const title = artifact?.title?.trim() || "artifact";
  const extension = artifact?.artifactType === "image" ? ".png" : "";
  return `${title}${extension}`;
}

function resolveArtifactContentType(artifact: Awaited<ReturnType<typeof findArtifactRecord>>) {
  const payload = toObjectRecord(artifact?.payloadJson);
  const mimeType =
    payload && typeof payload.mimeType === "string"
      ? payload.mimeType.trim()
      : "";
  if (mimeType) {
    return mimeType;
  }

  return artifact?.artifactType === "image"
    ? "image/png"
    : "application/octet-stream";
}

export class ContentArtifactsService {
  async listArtifacts(input: {
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
      limit: input.limit,
    });

    return {
      items: artifacts.map((artifact) => ({
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
        errorCode: artifact.errorCode,
        errorMessage: artifact.errorMessage,
        createdBy: artifact.createdBy,
        completedAt: artifact.completedAt,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        previewUrl:
          artifact.storageKey && artifact.status === "ready"
            ? this.buildArtifactFileUrl({
                workspaceId: workspace.id,
                artifactId: artifact.id,
              })
            : null,
      })),
    };
  }

  buildArtifactFileUrl(input: {
    workspaceId: string;
    artifactId: string;
  }) {
    return `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/file`;
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
    };
  }
}

export const contentArtifactsService = new ContentArtifactsService();
