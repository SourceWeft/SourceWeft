import { requireContentWorkspace } from "../content-support";
import { ContentError } from "../errors";
import { jobsQueue } from "../../../shared/queue";
import { downloadArtifactObject } from "../storage";
import { buildVideoPresentationProjectFileName } from "../video-presentation/spec";
import {
  sanitizeArtifactDownloadFileBaseName,
  withFileExtension,
} from "./filenames";
import {
  findArtifactRecord,
  listArtifactRecords,
  markArtifactFailed,
  markStaleVideoPresentationArtifactsFailed,
} from "./repository";

const STALE_VIDEO_PRESENTATION_ARTIFACT_MS = 10 * 60_000;
const VISUAL_HTML_DECK_RENDERER = "visual_html_deck";

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isStaleVideoPresentationArtifact(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
  now = new Date(),
) {
  if (artifact?.artifactType !== "video_presentation") {
    return false;
  }
  if (artifact.status !== "pending" && artifact.status !== "running") {
    return false;
  }
  const updatedAt = new Date(artifact.updatedAt);
  return (
    !Number.isNaN(updatedAt.getTime()) &&
    now.getTime() - updatedAt.getTime() >= STALE_VIDEO_PRESENTATION_ARTIFACT_MS
  );
}

async function withStaleVideoPresentationArtifactFailure<
  TArtifact extends Awaited<ReturnType<typeof findArtifactRecord>>,
>(artifact: TArtifact, now = new Date(), persist = true): Promise<TArtifact> {
  if (!isStaleVideoPresentationArtifact(artifact, now) || !artifact) {
    return artifact;
  }
  const payload = toObjectRecord(artifact.payloadJson) ?? {};
  const generation = toObjectRecord(payload.generation);
  const failedArtifact = {
    ...artifact,
    status: "failed",
    errorCode: artifact.errorCode ?? "VIDEO_PRESENTATION_RENDER_STALE",
    errorMessage:
      artifact.errorMessage ??
      "Video presentation project generation did not complete. Please retry.",
    payloadJson: {
      ...payload,
      generation: {
        ...(generation ?? {}),
        status: "failed",
        stage: "failed",
        errorCode: "VIDEO_PRESENTATION_RENDER_STALE",
        errorMessage:
          "Video presentation project generation did not complete. Please retry.",
      },
    },
  };
  if (persist) {
    await markStaleVideoPresentationArtifactsFailed({
      artifactId: artifact.id,
      teamId: artifact.teamId,
      workspaceId: artifact.workspaceId,
      threadId: artifact.threadId,
      requestKey:
        typeof payload.requestKey === "string" ? payload.requestKey : undefined,
      staleBefore: now,
    });
  }
  return failedArtifact;
}

function getVideoPresentationJobId(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  if (artifact?.artifactType !== "video_presentation") {
    return null;
  }
  const payload = toObjectRecord(artifact.payloadJson);
  const jobId =
    payload && typeof payload.jobId === "string" ? payload.jobId : "";
  return jobId.trim() || null;
}

async function withTerminalVideoPresentationJobFailure<
  TArtifact extends Awaited<ReturnType<typeof findArtifactRecord>>,
>(
  artifact: TArtifact,
  queue: Pick<typeof jobsQueue, "getJob"> = jobsQueue,
  persist = true,
): Promise<TArtifact> {
  if (
    !artifact ||
    artifact.artifactType !== "video_presentation" ||
    (artifact.status !== "pending" && artifact.status !== "running")
  ) {
    return artifact;
  }
  const jobId = getVideoPresentationJobId(artifact);
  if (!jobId) {
    return artifact;
  }
  const job = await queue.getJob(jobId).catch(() => null);
  if (!job) {
    return artifact;
  }
  const state = await job.getState().catch(() => null);
  if (state !== "failed") {
    return artifact;
  }
  const failedReason =
    job.failedReason || "Video presentation project generation failed.";
  const errorCode = "VIDEO_PRESENTATION_RENDER_FAILED";
  const payload = toObjectRecord(artifact.payloadJson) ?? {};
  const generation = toObjectRecord(payload.generation);
  const failedArtifact = {
    ...artifact,
    status: "failed",
    errorCode: artifact.errorCode ?? errorCode,
    errorMessage: artifact.errorMessage ?? failedReason,
    payloadJson: {
      ...payload,
      generation: {
        ...(generation ?? {}),
        status: "failed",
        stage: "project_failed",
        errorCode,
        errorMessage: failedReason,
      },
    },
  };
  if (persist) {
    await markArtifactFailed({
      artifactId: artifact.id,
      teamId: artifact.teamId,
      workspaceId: artifact.workspaceId,
      expectedStatuses: ["pending", "running"],
      errorCode,
      errorMessage: failedReason,
      payload: failedArtifact.payloadJson,
    });
  }
  return failedArtifact;
}

async function normalizeVideoPresentationArtifactStatus<
  TArtifact extends Awaited<ReturnType<typeof findArtifactRecord>>,
>(artifact: TArtifact): Promise<TArtifact> {
  const terminalJobArtifact =
    await withTerminalVideoPresentationJobFailure(artifact);
  return withStaleVideoPresentationArtifactFailure(terminalJobArtifact);
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
      : artifact?.artifactType === "video_presentation"
        ? ".video-presentation.json"
        : "";
  return artifact?.artifactType === "video_presentation"
    ? buildVideoPresentationProjectFileName(title)
    : `${title}${extension}`;
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
    ? "image/png"
    : "application/octet-stream";
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
  if (artifact?.artifactType === "video_presentation") {
    return (
      artifact.status === "pending" ||
      artifact.status === "running" ||
      artifact.status === "ready"
    );
  }
  if (!artifact?.storageKey) {
    return false;
  }
  if (artifact.status === "ready") {
    return true;
  }
  return false;
}

function buildArtifactCapabilities(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  const hasFile = Boolean(
    artifact?.artifactType !== "video_presentation" &&
      artifact?.status === "ready" &&
      artifact.storageKey,
  );
  return {
    canOpenFile: hasFile,
    canDownloadFile: hasFile,
    canPreviewInline: hasArtifactPreviewFile(artifact),
    canRenderClientVideo:
      artifact?.artifactType === "video_presentation" && artifact.status === "ready",
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
          : "application/octet-stream",
      fileName: decodedFileName,
      storageBucket: artifact.storageBucket,
      storageKey: artifact.storageKey,
    };
  }

  const video = toObjectRecord(payload.video);
  const mp4 = toObjectRecord(payload.mp4);
  if (
    mp4 &&
    typeof mp4.fileName === "string" &&
    mp4.fileName === decodedFileName
  ) {
    const storageKey =
      typeof mp4.storageKey === "string" ? mp4.storageKey.trim() : "";
    if (storageKey) {
      return {
        contentType:
          typeof mp4.mimeType === "string" ? mp4.mimeType : "video/mp4",
        fileName: decodedFileName,
        storageBucket:
          typeof mp4.storageBucket === "string" &&
          mp4.storageBucket.trim().length > 0
            ? mp4.storageBucket.trim()
            : artifact.storageBucket,
        storageKey,
      };
    }
  }

  const manifest = toObjectRecord(payload.manifest);
  if (
    manifest &&
    typeof manifest.fileName === "string" &&
    manifest.fileName === decodedFileName
  ) {
    const storageKey =
      typeof manifest.storageKey === "string" ? manifest.storageKey.trim() : "";
    if (storageKey) {
      return {
        contentType:
          typeof manifest.mimeType === "string"
            ? manifest.mimeType
            : "application/json",
        fileName: decodedFileName,
        storageBucket:
          typeof manifest.storageBucket === "string" &&
          manifest.storageBucket.trim().length > 0
            ? manifest.storageBucket.trim()
            : artifact.storageBucket,
        storageKey,
      };
    }
  }

  const audioTracks = Array.isArray(video?.audioTracks)
    ? video.audioTracks
    : [];
  for (const item of audioTracks) {
    const track = toObjectRecord(item);
    if (!track || track.fileName !== decodedFileName) {
      continue;
    }
    const storageKey =
      typeof track.storageKey === "string" ? track.storageKey.trim() : "";
    if (!storageKey) {
      continue;
    }
    return {
      contentType:
        typeof track.mimeType === "string"
          ? track.mimeType
          : "application/octet-stream",
      fileName: decodedFileName,
      storageBucket:
        typeof track.storageBucket === "string" &&
        track.storageBucket.trim().length > 0
          ? track.storageBucket.trim()
          : artifact.storageBucket,
      storageKey,
    };
  }

  return null;
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
      items: await Promise.all(
        artifacts.items.map(async (artifact) => {
          const normalizedArtifact =
            await normalizeVideoPresentationArtifactStatus(artifact);
          return this.buildArtifactResponse({
            artifact: normalizedArtifact,
            workspaceId: workspace.id,
          });
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

    const normalizedArtifact =
      await normalizeVideoPresentationArtifactStatus(artifact);

    return {
      artifact: this.buildArtifactResponse({
        artifact: normalizedArtifact,
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
    if (artifact.artifactType === "video_presentation") {
      throw new ContentError(
        400,
        "VIDEO_PRESENTATION_FILE_UNAVAILABLE",
        "Video presentation is a client-rendered project artifact.",
      );
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
  buildArtifactCapabilities,
  isStaleVideoPresentationArtifact,
  resolveArtifactAsset,
  resolveArtifactFileName,
  resolveArtifactRenderer,
  withTerminalVideoPresentationJobFailure,
  withStaleVideoPresentationArtifactFailure,
};
