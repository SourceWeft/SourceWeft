import { createHash } from "node:crypto";
import {
  ARTIFACT_MIME_TYPES,
  extensionForMimeType,
  isInlinePreviewableMimeType,
  normalizeMimeType,
  sniffAudioMimeType,
} from "@sourceweft/contracts/artifact-files";
import { ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES } from "@sourceweft/contracts/artifact-storage";
import {
  buildArtifactPreviewUrl as buildArtifactPreviewPageUrl,
  buildArtifactRestUrl,
  buildArtifactVersionMediaRestUrl,
} from "@sourceweft/contracts/artifact-urls";
import type {
  ArtifactCapabilities,
  ArtifactVersionMedia,
  ArtifactVersionMediaAssetLocation,
  ArtifactViewHandler,
} from "@sourceweft/contracts";
import { artifactVersionMediaProjectionSchema } from "@sourceweft/contracts";
import { requireContentWorkspace } from "../workspace/guards";
import { workspaceService } from "../workspace";
import { canViewContent } from "../workspace/content-visibility";
import { ContentError } from "../content/errors";
import {
  deleteArtifactObject,
  deleteArtifactObjectsByPrefix,
  downloadArtifactObject,
  downloadArtifactObjectRange,
  downloadArtifactObjectWithMetadata,
} from "../sources/storage";
import {
  findPubliclySharedArtifactIds,
  revokeShareLink,
} from "../sharing/store";
import { teamAuditService } from "../team-audit";
import { logger } from "../../shared/logger";
import {
  deleteArtifactRecord,
  findArtifactRecord,
  findCurrentReadyArtifactVersionRecord,
  findReadyArtifactVersionRecord,
  listCurrentReadyArtifactVersionRecords,
  listArtifactVersionContentRecords,
  listArtifactRecords,
  listArtifactSummaryRecords,
} from "./repository";
import { loadArtifactViewHandlerRegistry } from "./view-handlers";
import { toObjectRecord } from "../../shared/records";

type ArtifactRecord = Awaited<ReturnType<typeof findArtifactRecord>>;
type ExactArtifactVersionRecord = NonNullable<
  Awaited<ReturnType<typeof findReadyArtifactVersionRecord>>
>;
type CurrentArtifactVersionRecord = NonNullable<
  Awaited<ReturnType<typeof findCurrentReadyArtifactVersionRecord>>
>;

export type ArtifactVersionMediaResource = "video" | "cover";

export type ArtifactVersionMediaBytesResult =
  | {
      kind: "bytes";
      status: 200 | 206;
      body: Uint8Array;
      contentType: string;
      fileName: string;
      etag: string;
      contentLength: number;
      totalLength: number;
      contentRange?: string;
      download: boolean;
    }
  | { kind: "not_modified"; etag: string }
  | { kind: "range_not_satisfiable"; etag: string; totalLength: number };

export function isArtifactOwnedStorageKey(input: {
  workspaceId: string;
  artifactId: string;
  storageKey: string;
}) {
  return input.storageKey.startsWith(
    `workspaces/${input.workspaceId}/artifacts/${input.artifactId}/`,
  );
}

export function resolveByteRange(value: string, totalLength: number) {
  if (!Number.isSafeInteger(totalLength) || totalLength <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, totalLength - suffixLength),
      end: totalLength - 1,
    };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : totalLength - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= totalLength
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, totalLength - 1) };
}

function versionMediaEtag(contentDigest: string) {
  const opaque = createHash("sha256").update(contentDigest).digest("hex");
  return `"sourceweft-${opaque}"`;
}

function etagMatches(header: string | undefined, etag: string) {
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//u, ""))
    .some((value) => value === "*" || value === etag);
}

function exactVersionArtifact(record: ExactArtifactVersionRecord) {
  return {
    ...record,
    payloadJson: record.contentJson,
  };
}

function assertVersionMediaStorage(input: {
  workspaceId: string;
  artifactId: string;
  media: ArtifactVersionMedia;
}) {
  for (const location of [input.media.media, input.media.coverImage]) {
    if (
      location &&
      (!isArtifactOwnedStorageKey({
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        storageKey: location.storageKey,
      }) ||
        location.byteLength > ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES)
    ) {
      throw new ContentError(
        404,
        "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
        "Artifact version media not found",
      );
    }
  }
}

function buildVersionMediaProjection(input: {
  workspaceId: string;
  artifactId: string;
  artifactVersionId: string;
  artifactType: string;
  media: ArtifactVersionMedia;
}) {
  const routeInput = {
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    artifactVersionId: input.artifactVersionId,
  };
  return artifactVersionMediaProjectionSchema.parse({
    artifactId: input.artifactId,
    artifactVersionId: input.artifactVersionId,
    artifactType: input.artifactType,
    title: input.media.title,
    description: input.media.description ?? null,
    durationSeconds: input.media.durationSeconds ?? null,
    media: {
      url: buildArtifactVersionMediaRestUrl({
        ...routeInput,
        resource: "video",
      }),
      downloadUrl: buildArtifactVersionMediaRestUrl({
        ...routeInput,
        resource: "video",
        download: true,
      }),
      contentType: input.media.media.contentType,
      fileName: input.media.media.fileName,
      byteLength: input.media.media.byteLength,
      ...(input.media.media.width ? { width: input.media.media.width } : {}),
      ...(input.media.media.height ? { height: input.media.media.height } : {}),
      ...(input.media.media.fps ? { fps: input.media.media.fps } : {}),
      ...(typeof input.media.media.hasAudio === "boolean"
        ? { hasAudio: input.media.media.hasAudio }
        : {}),
    },
    coverImage: input.media.coverImage
      ? {
          url: buildArtifactVersionMediaRestUrl({
            ...routeInput,
            resource: "cover",
          }),
          contentType: input.media.coverImage.contentType,
          fileName: input.media.coverImage.fileName,
          byteLength: input.media.coverImage.byteLength,
          ...(input.media.coverImage.width
            ? { width: input.media.coverImage.width }
            : {}),
          ...(input.media.coverImage.height
            ? { height: input.media.coverImage.height }
            : {}),
        }
      : null,
  });
}

async function readVersionMediaBytes(input: {
  location: ArtifactVersionMediaAssetLocation;
  range?: string;
  ifNoneMatch?: string;
  download: boolean;
}): Promise<ArtifactVersionMediaBytesResult> {
  const { location } = input;
  const etag = versionMediaEtag(location.contentDigest);
  if (etagMatches(input.ifNoneMatch, etag)) {
    return { kind: "not_modified", etag };
  }
  const range = input.range
    ? resolveByteRange(input.range, location.byteLength)
    : undefined;
  if (input.range && !range) {
    return {
      kind: "range_not_satisfiable",
      etag,
      totalLength: location.byteLength,
    };
  }
  if (range) {
    const ranged = await downloadArtifactObjectRange({
      bucket: location.storageBucket,
      key: location.storageKey,
      start: range.start,
      end: range.end,
      totalLength: location.byteLength,
    });
    if (!ranged) {
      throw new ContentError(
        404,
        "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
        "Artifact version media not found",
      );
    }
    return {
      kind: "bytes",
      status: 206,
      body: ranged.body,
      contentType: location.contentType,
      fileName: location.fileName,
      etag,
      contentLength: ranged.body.byteLength,
      totalLength: location.byteLength,
      contentRange: `bytes ${range.start}-${range.end}/${location.byteLength}`,
      download: input.download,
    };
  }
  const stored = await downloadArtifactObjectWithMetadata({
    bucket: location.storageBucket,
    key: location.storageKey,
    maxBytes: location.byteLength,
  });
  if (!stored) {
    throw new ContentError(
      404,
      "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
      "Artifact version media not found",
    );
  }
  const body = stored.body;
  const actualDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (
    body.byteLength !== location.byteLength ||
    actualDigest !== location.contentDigest
  ) {
    throw new ContentError(
      502,
      "ARTIFACT_VERSION_MEDIA_INTEGRITY_FAILED",
      "Artifact version media failed integrity verification",
    );
  }
  return {
    kind: "bytes",
    status: 200,
    body,
    contentType: location.contentType,
    fileName: location.fileName,
    etag,
    contentLength: body.byteLength,
    totalLength: body.byteLength,
    download: input.download,
  };
}

/**
 * Every per-artifact-type decision below follows the same shape: ask the
 * registered handler first, fall back to the generic answer (payload metadata,
 * else the file's MIME type) when no capability takes the type over. `image`
 * and `file` are top-level media the host may reason about; anything more
 * specific belongs to the capability that produces it.
 */

function resolveArtifactFileName(
  artifact: ArtifactRecord,
  handler?: ArtifactViewHandler | null,
) {
  if (artifact) {
    const handled = handler?.resolveFileName?.({ artifact });
    if (handled) {
      return handled;
    }
  }

  const payload = toObjectRecord(artifact?.payloadJson);
  const fileName =
    payload && typeof payload.fileName === "string"
      ? payload.fileName.trim()
      : "";
  if (fileName) {
    return fileName;
  }

  const title = artifact?.title?.trim() || "artifact";
  const extension =
    artifact?.artifactType === "image"
      ? extensionForMimeType(
          resolveArtifactContentType(artifact, handler),
          ".png",
        )
      : "";
  return `${title}${extension}`;
}

function resolveArtifactContentType(
  artifact: ArtifactRecord,
  handler?: ArtifactViewHandler | null,
) {
  if (artifact) {
    const handled = handler?.resolveContentType?.({ artifact });
    if (handled) {
      return handled;
    }
  }

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

/**
 * Whether a browser renders these bytes inside an iframe rather than downloading
 * them (a blank frame). Images/text/PDF/JSON render and media plays; office
 * documents and arbitrary binaries download. The public share page uses this to
 * decide between embedding the file and falling back to the poster image.
 */
function isBrowserRenderableContentType(contentType: string) {
  const normalized = contentType.toLowerCase();
  return (
    isInlinePreviewableContentType(contentType) ||
    normalized.startsWith("video/") ||
    normalized.startsWith("audio/")
  );
}

function resolveArtifactRenderer(
  artifact: ArtifactRecord,
  handler?: ArtifactViewHandler | null,
) {
  if (!artifact) {
    return null;
  }
  return handler?.resolveRenderer?.({ artifact }) ?? null;
}

function hasArtifactPreviewFile(
  artifact: ArtifactRecord,
  handler?: ArtifactViewHandler | null,
) {
  if (!artifact || !artifact.storageKey || artifact.status !== "ready") {
    return false;
  }

  const contentType = resolveArtifactContentType(artifact, handler);
  const handled = handler?.canPreviewInline?.({ artifact, contentType });
  if (typeof handled === "boolean") {
    return handled;
  }

  if (artifact.artifactType === "image") {
    return true;
  }

  if (artifact.artifactType === "file") {
    return isInlinePreviewableContentType(contentType);
  }

  return false;
}

/**
 * Generic fallback (a stored file, served by MIME type) plus one lookup: does a
 * capability take this artifact type over? A registered handler means the
 * client renders the artifact from its payload, so it is openable even before —
 * or without ever — producing a file. A failed artifact renders nothing.
 */
function buildArtifactCapabilities(
  artifact: ArtifactRecord,
  handler?: ArtifactViewHandler | null,
): ArtifactCapabilities {
  const hasFile = Boolean(artifact?.status === "ready" && artifact.storageKey);
  // A capability may keep its primary deliverable in the payload rather than the
  // top-level storageKey column (e.g. a video presentation's server-rendered
  // mp4 under `payload.renderedVideo`). Ask the handler the same way the public
  // `/raw` serve does, so the projection reports a real downloadable file
  // without the host knowing any artifact type. Only consulted when there is no
  // top-level file and the artifact is ready.
  const hasHandlerPrimaryFile = Boolean(
    artifact &&
    artifact.status === "ready" &&
    !artifact.storageKey &&
    handler?.resolvePrimaryFile?.({ artifact }),
  );
  const canRenderClientSide = Boolean(
    artifact && handler && artifact.status !== "failed",
  );
  return {
    canOpenFile: hasFile || canRenderClientSide,
    canDownloadFile: hasFile || hasHandlerPrimaryFile,
    canPreviewInline: hasArtifactPreviewFile(artifact, handler),
    canRenderClientSide,
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
  handler?: ArtifactViewHandler | null,
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

  // Anything beyond the artifact's own stored file is payload-shaped knowledge
  // owned by the capability that produced the artifact.
  return (
    handler?.resolveAsset?.({ artifact, fileName: decodedFileName }) ?? null
  );
}

function resolveArtifactPreviewImage(
  artifact: Awaited<ReturnType<typeof findArtifactRecord>>,
) {
  // Any artifact type may carry a thumbnail; having one stored is the only
  // thing that qualifies it. Publishers/pipelines decide whether to write one.
  if (!artifact || artifact.status !== "ready") {
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
    typeof metadata?.mimeType === "string" ? metadata.mimeType.trim() : "";
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
  /**
   * Resolves one artifact for a member, enforcing both the workspace boundary
   * and row-level visibility. A private artifact belonging to another member is
   * reported absent, so its existence stays private and no single-artifact
   * operation (view, download, preview, source JSON) can reach it by id.
   */
  private async requireViewableArtifact(input: {
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

    if (!artifact || !canViewContent(input.userId, artifact)) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }

    return { workspace, artifact };
  }

  private async requireViewableArtifactVersion(input: {
    workspaceId: string;
    artifactId: string;
    artifactVersionId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const version = await findReadyArtifactVersionRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      artifactId: input.artifactId,
      artifactVersionId: input.artifactVersionId,
    });
    if (!version || !canViewContent(input.userId, version)) {
      throw new ContentError(
        404,
        "ARTIFACT_VERSION_NOT_FOUND",
        "Artifact version not found",
      );
    }
    return { workspace, version };
  }

  private buildArtifactResponse(input: {
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>;
    workspaceId: string;
    handler?: ArtifactViewHandler | null;
    isPublic?: boolean;
    artifactVersionId?: string | null;
  }) {
    const { artifact, workspaceId } = input;
    return {
      id: artifact.id,
      artifactVersionId: input.artifactVersionId ?? null,
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
      visibility: artifact.visibility,
      isPublic: input.isPublic ?? false,
      createdBy: artifact.createdBy,
      completedAt: artifact.completedAt,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      previewUrl: hasArtifactPreviewFile(artifact, input.handler)
        ? this.buildArtifactPreviewUrl({
            workspaceId,
            artifactId: artifact.id,
          })
        : null,
      capabilities: buildArtifactCapabilities(artifact, input.handler),
    };
  }

  private async buildWebArtifactResponse(input: {
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>;
    teamId: string;
    workspaceId: string;
    userId: string;
    handler?: ArtifactViewHandler | null;
    isPublic?: boolean;
    currentVersion?: CurrentArtifactVersionRecord | null;
  }) {
    const base = this.buildArtifactResponse(input);
    if (!input.handler?.resolveVersionMedia) return base;
    const unavailable = () => ({
      ...base,
      payloadJson: {},
      storageBucket: null,
      storageKey: null,
      previewStorageKey: null,
      previewMetadataJson: {},
      previewUrl: null,
    });
    if (input.artifact.status !== "ready") return unavailable();
    const version =
      "currentVersion" in input
        ? input.currentVersion
        : await findCurrentReadyArtifactVersionRecord({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            artifactId: input.artifact.id,
            expectedArtifactType: input.artifact.artifactType,
          });
    if (version && !canViewContent(input.userId, version)) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }
    const media = version
      ? input.handler.resolveVersionMedia({
          artifact: {
            ...input.artifact,
            payloadJson: version.contentJson,
          },
        })
      : null;
    if (!version || !media) return unavailable();
    try {
      assertVersionMediaStorage({
        workspaceId: input.workspaceId,
        artifactId: input.artifact.id,
        media,
      });
    } catch {
      return unavailable();
    }
    const projection = buildVersionMediaProjection({
      workspaceId: input.workspaceId,
      artifactId: input.artifact.id,
      artifactVersionId: version.versionId,
      artifactType: input.artifact.artifactType,
      media,
    });
    return {
      ...base,
      artifactVersionId: version.versionId,
      title: projection.title,
      promptText: projection.description,
      payloadJson: projection,
      storageBucket: null,
      storageKey: null,
      previewStorageKey: null,
      previewMetadataJson: {},
      previewUrl: projection.coverImage?.url ?? null,
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
      viewerUserId: input.userId,
    });
    const registry = await loadArtifactViewHandlerRegistry();
    const publicArtifactIds = await findPubliclySharedArtifactIds(
      artifacts.items.map((artifact) => artifact.id),
    );
    const versionedArtifactIds = artifacts.items
      .filter((artifact) =>
        Boolean(
          registry.handlerFor(artifact.artifactType)?.resolveVersionMedia,
        ),
      )
      .map((artifact) => artifact.id);
    const currentVersions = await listCurrentReadyArtifactVersionRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      artifactIds: versionedArtifactIds,
    });
    const currentVersionByArtifact = new Map(
      currentVersions.map((version) => [version.artifactId, version]),
    );

    return {
      items: await Promise.all(
        artifacts.items.map((artifact) =>
          this.buildWebArtifactResponse({
            artifact,
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            userId: input.userId,
            handler: registry.handlerFor(artifact.artifactType),
            isPublic: publicArtifactIds.has(artifact.id),
            currentVersion: currentVersionByArtifact.get(artifact.id) ?? null,
          }),
        ),
      ),
      nextCursor: artifacts.nextCursor,
    };
  }

  async listArtifactSummaries(input: {
    cursor?: string;
    workspaceId: string;
    userId: string;
    limit?: number;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const artifacts = await listArtifactSummaryRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      cursor: decodeArtifactCursor(input.cursor),
      limit: input.limit,
      viewerUserId: input.userId,
    });
    const publicArtifactIds = await findPubliclySharedArtifactIds(
      artifacts.items.map((artifact) => artifact.id),
    );

    return {
      items: artifacts.items.map((artifact) => ({
        id: artifact.id,
        workspaceId: artifact.workspaceId,
        threadId: artifact.threadId,
        artifactType: artifact.artifactType,
        status: artifact.status,
        title: artifact.title,
        promptExcerpt: artifact.promptExcerpt,
        visibility: artifact.visibility,
        isPublic: publicArtifactIds.has(artifact.id),
        createdAt: artifact.createdAt,
        completedAt: artifact.completedAt,
        updatedAt: artifact.updatedAt,
        hasPrimaryFile: artifact.hasPrimaryFile,
        primaryFileUrl: artifact.hasPrimaryFile
          ? buildArtifactRestUrl({
              workspaceId: workspace.id,
              artifactId: artifact.id,
            })
          : null,
        previewImage: artifact.hasPreviewImage
          ? {
              url: buildArtifactRestUrl({
                workspaceId: workspace.id,
                artifactId: artifact.id,
                resource: { kind: "previewImage" },
              })!,
              altText: artifact.previewAltText,
            }
          : null,
      })),
      nextCursor: artifacts.nextCursor,
    };
  }

  async getArtifact(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    const { workspace, artifact } = await this.requireViewableArtifact(input);

    const registry = await loadArtifactViewHandlerRegistry();
    const publicArtifactIds = await findPubliclySharedArtifactIds([
      artifact.id,
    ]);
    const handler = registry.handlerFor(artifact.artifactType);
    return {
      artifact: await this.buildWebArtifactResponse({
        artifact,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
        handler,
        isPublic: publicArtifactIds.has(artifact.id),
      }),
    };
  }

  async getArtifactVersionMedia(input: {
    workspaceId: string;
    artifactId: string;
    artifactVersionId: string;
    userId: string;
  }) {
    const { workspace, version } =
      await this.requireViewableArtifactVersion(input);
    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(version.artifactType);
    const media = handler?.resolveVersionMedia?.({
      artifact: exactVersionArtifact(version),
    });
    if (!media) {
      throw new ContentError(
        404,
        "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
        "Artifact version media not found",
      );
    }
    assertVersionMediaStorage({
      workspaceId: workspace.id,
      artifactId: version.id,
      media,
    });
    return {
      media: buildVersionMediaProjection({
        workspaceId: workspace.id,
        artifactId: version.id,
        artifactVersionId: version.versionId,
        artifactType: version.artifactType,
        media,
      }),
    };
  }

  async getArtifactVersionMediaBytes(input: {
    workspaceId: string;
    artifactId: string;
    artifactVersionId: string;
    userId: string;
    resource: ArtifactVersionMediaResource;
    range?: string;
    ifNoneMatch?: string;
    download: boolean;
  }): Promise<ArtifactVersionMediaBytesResult> {
    const { workspace, version } =
      await this.requireViewableArtifactVersion(input);
    const registry = await loadArtifactViewHandlerRegistry();
    const media = registry
      .handlerFor(version.artifactType)
      ?.resolveVersionMedia?.({ artifact: exactVersionArtifact(version) });
    if (!media) {
      throw new ContentError(
        404,
        "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
        "Artifact version media not found",
      );
    }
    assertVersionMediaStorage({
      workspaceId: workspace.id,
      artifactId: version.id,
      media,
    });
    const location =
      input.resource === "video" ? media.media : media.coverImage;
    if (!location) {
      throw new ContentError(
        404,
        "ARTIFACT_VERSION_MEDIA_NOT_FOUND",
        "Artifact version media not found",
      );
    }
    return readVersionMediaBytes({
      location,
      range: input.range,
      ifNoneMatch: input.ifNoneMatch,
      download: input.download,
    });
  }

  buildArtifactPreviewUrl(input: { workspaceId: string; artifactId: string }) {
    return buildArtifactPreviewPageUrl(input);
  }

  /**
   * Permanently delete one artifact.
   *
   * Authorization mirrors sharing's `requireShareableArtifact`: only the
   * artifact's creator or a workspace admin may delete, because deletion (like
   * publication) is a decision about the item itself, not mere access to it.
   * `ARTIFACT_NOT_FOUND` hides existence from callers without access.
   *
   * Order matters: the share link is revoked first (a public URL must stop
   * resolving even if a later step dies), then the row goes (versions and
   * artifact-source rows cascade), and only then the stored bytes — a failed
   * byte delete leaves an unreferenced object, which beats a row that points
   * at bytes we already destroyed. Byte deletion is best-effort by design.
   */
  async deleteArtifact(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    const access = await workspaceService.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    if (!access || access.role === null) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }

    const artifact = await findArtifactRecord({
      teamId: access.organizationId,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    });
    if (!artifact || !canViewContent(input.userId, artifact)) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }

    const isCreator = artifact.createdBy === input.userId;
    if (!isCreator && !workspaceService.canAdministerContent(access)) {
      throw new ContentError(
        403,
        "ARTIFACT_DELETE_FORBIDDEN",
        "Only the artifact's creator or a workspace admin can delete it.",
      );
    }

    const registry = await loadArtifactViewHandlerRegistry();
    const versionMediaObjects = new Map<
      string,
      { bucket: string | null; key: string }
    >();
    const versionHandler = registry.handlerFor(artifact.artifactType);
    if (
      versionHandler?.listOwnedStorageObjects ||
      versionHandler?.resolveVersionMedia
    ) {
      const versions = await listArtifactVersionContentRecords({
        teamId: access.organizationId,
        workspaceId: input.workspaceId,
        artifactId: artifact.id,
      });
      for (const version of versions) {
        const versionArtifact = {
          ...artifact,
          payloadJson: version.contentJson,
        };
        const media = versionHandler.resolveVersionMedia?.({
          artifact: versionArtifact,
        });
        const locations =
          versionHandler.listOwnedStorageObjects?.({
            artifact: versionArtifact,
          }) ?? (media ? [media.media, media.coverImage] : []);
        for (const location of locations) {
          if (
            !location ||
            !isArtifactOwnedStorageKey({
              workspaceId: input.workspaceId,
              artifactId: artifact.id,
              storageKey: location.storageKey,
            })
          ) {
            continue;
          }
          const bucket = location.storageBucket ?? artifact.storageBucket;
          versionMediaObjects.set(
            `${bucket ?? ""}\u0000${location.storageKey}`,
            {
              bucket,
              key: location.storageKey,
            },
          );
        }
      }
    }

    await revokeShareLink({
      targetType: "artifact",
      targetId: artifact.id,
    });

    const deleted = await deleteArtifactRecord({
      teamId: access.organizationId,
      workspaceId: input.workspaceId,
      artifactId: artifact.id,
    });
    if (!deleted) {
      throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }

    // Every stored object the row referenced. The payload's source JSON may
    // live in its own bucket (resolveSourceJsonStorageBucket); the primary file
    // and the preview share the artifact's bucket.
    const payload = toObjectRecord(artifact.payloadJson);
    const sourceJsonStorageKey =
      payload && typeof payload.sourceJsonStorageKey === "string"
        ? payload.sourceJsonStorageKey.trim()
        : "";
    const storedObjects = [
      ...versionMediaObjects.values(),
      ...(artifact.storageKey
        ? [{ bucket: artifact.storageBucket, key: artifact.storageKey }]
        : []),
      ...(artifact.previewStorageKey
        ? [{ bucket: artifact.storageBucket, key: artifact.previewStorageKey }]
        : []),
      ...(sourceJsonStorageKey
        ? [
            {
              bucket: resolveSourceJsonStorageBucket(artifact),
              key: sourceJsonStorageKey,
            },
          ]
        : []),
    ];
    for (const object of storedObjects) {
      try {
        await deleteArtifactObject(object);
      } catch (error) {
        logger.warn("artifact_stored_object_delete_failed", {
          artifactId: artifact.id,
          key: object.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await deleteArtifactObjectsByPrefix({
        prefix: `workspaces/${input.workspaceId}/artifacts/${artifact.id}/`,
      });
    } catch (error) {
      logger.warn("artifact_storage_prefix_delete_failed", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await teamAuditService.record({
      teamId: access.organizationId,
      actorUserId: input.userId,
      action: "artifact.deleted",
      targetType: "artifact",
      targetId: artifact.id,
      metadata: {
        artifactType: artifact.artifactType,
        status: artifact.status,
        title: artifact.title,
      },
    });

    return { deleted: true as const, artifactId: artifact.id };
  }

  async getArtifactFile(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    const { artifact } = await this.requireViewableArtifact(input);

    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);
    if (handler?.resolveVersionMedia) {
      throw new ContentError(
        404,
        "ARTIFACT_FILE_MISSING",
        "Artifact has no generic stored file",
      );
    }

    // Capabilities that keep their deliverable in the payload (e.g. a video
    // presentation's rendered mp4) have no top-level storageKey; serve the
    // handler's declared primary file instead, mirroring getSharedArtifactFile
    // so the authenticated /file and /download routes behave like the public
    // /raw serve. No such file means there is genuinely nothing to download.
    if (!artifact.storageKey) {
      const primary = handler?.resolvePrimaryFile?.({ artifact });
      if (!primary) {
        throw new ContentError(
          400,
          "ARTIFACT_FILE_MISSING",
          "Artifact has no stored file",
        );
      }
      return {
        body: await downloadArtifactObject({
          bucket: primary.storageBucket,
          key: primary.storageKey,
        }),
        contentType: primary.contentType,
        fileName: primary.fileName,
        renderer: resolveArtifactRenderer(artifact, handler),
      };
    }

    return {
      body: await downloadArtifactObject({
        bucket: artifact.storageBucket,
        key: artifact.storageKey,
      }),
      contentType: resolveArtifactContentType(artifact, handler),
      fileName: resolveArtifactFileName(artifact, handler),
      renderer: resolveArtifactRenderer(artifact, handler),
    };
  }

  async getArtifactSourceJson(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }) {
    const { artifact } = await this.requireViewableArtifact(input);

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

    const registry = await loadArtifactViewHandlerRegistry();
    const source = registry
      .handlerFor(artifact.artifactType)
      ?.buildSourceJson?.({ artifact });
    if (source) {
      return {
        body: Buffer.from(JSON.stringify(source.payload, null, 2), "utf8"),
        contentType: "application/json",
        fileName: source.fileName ?? resolveSourceJsonFileName(artifact),
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
    const { artifact } = await this.requireViewableArtifact(input);
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

  /**
   * File bytes for an artifact that a *share* has already authorized. There is
   * no per-user check here on purpose: the caller (the public share route) has
   * validated a live share token, which is the access grant. Never call this
   * for an artifact the caller has not authorized.
   */
  async getSharedArtifactFile(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
  ) {
    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);
    if (handler?.resolveVersionMedia) {
      throw new ContentError(
        404,
        "ARTIFACT_FILE_MISSING",
        "Artifact has no generic stored file",
      );
    }
    // Capabilities that keep their deliverable in the payload (e.g. a video
    // presentation's rendered mp4) have no top-level storageKey; serve the
    // handler's declared primary file instead so the public share can play it.
    if (!artifact.storageKey) {
      const primary = handler?.resolvePrimaryFile?.({ artifact });
      if (!primary) {
        throw new ContentError(
          400,
          "ARTIFACT_FILE_MISSING",
          "Artifact has no stored file",
        );
      }
      return {
        body: await downloadArtifactObject({
          bucket: primary.storageBucket,
          key: primary.storageKey,
        }),
        contentType: primary.contentType,
        fileName: primary.fileName,
        renderer: resolveArtifactRenderer(artifact, handler),
      };
    }
    return {
      body: await downloadArtifactObject({
        bucket: artifact.storageBucket,
        key: artifact.storageKey,
      }),
      contentType: resolveArtifactContentType(artifact, handler),
      fileName: resolveArtifactFileName(artifact, handler),
      renderer: resolveArtifactRenderer(artifact, handler),
    };
  }

  async getSharedCurrentArtifactVersionMedia(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
  ) {
    const version = await findCurrentReadyArtifactVersionRecord({
      teamId: artifact.teamId,
      workspaceId: artifact.workspaceId,
      artifactId: artifact.id,
      expectedArtifactType: artifact.artifactType,
    });
    if (!version) return null;
    const registry = await loadArtifactViewHandlerRegistry();
    const media = registry
      .handlerFor(artifact.artifactType)
      ?.resolveVersionMedia?.({
        artifact: { ...artifact, payloadJson: version.contentJson },
      });
    if (!media) return null;
    assertVersionMediaStorage({
      workspaceId: artifact.workspaceId,
      artifactId: artifact.id,
      media,
    });
    return { versionId: version.versionId, media };
  }

  async getSharedArtifactVersionMediaBytes(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
    input: {
      artifactVersionId: string;
      resource: ArtifactVersionMediaResource;
      range?: string;
      ifNoneMatch?: string;
      download: boolean;
    },
  ): Promise<ArtifactVersionMediaBytesResult | null> {
    const version = await findCurrentReadyArtifactVersionRecord({
      teamId: artifact.teamId,
      workspaceId: artifact.workspaceId,
      artifactId: artifact.id,
      expectedArtifactType: artifact.artifactType,
    });
    if (!version || version.versionId !== input.artifactVersionId) return null;
    const registry = await loadArtifactViewHandlerRegistry();
    const media = registry
      .handlerFor(artifact.artifactType)
      ?.resolveVersionMedia?.({
        artifact: { ...artifact, payloadJson: version.contentJson },
      });
    if (!media) return null;
    assertVersionMediaStorage({
      workspaceId: artifact.workspaceId,
      artifactId: artifact.id,
      media,
    });
    const location =
      input.resource === "video" ? media.media : media.coverImage;
    if (!location) return null;
    return readVersionMediaBytes({
      location,
      range: input.range,
      ifNoneMatch: input.ifNoneMatch,
      download: input.download,
    });
  }

  /**
   * Whether the public share page can embed this artifact's bytes inline (vs.
   * falling back to its poster image). Handler-aware via the same content-type
   * resolution the `/raw` serve uses, so office decks (`.pptx`) etc. correctly
   * report false instead of rendering as a blank iframe.
   */
  async isSharedArtifactInlineRenderable(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
  ): Promise<boolean> {
    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);
    if (!artifact.storageKey) {
      // Fall back to the handler's payload-stored primary file (e.g. a rendered
      // mp4) and judge inline-renderability from its content type.
      const primary = handler?.resolvePrimaryFile?.({ artifact });
      return primary
        ? isBrowserRenderableContentType(primary.contentType)
        : false;
    }
    return isBrowserRenderableContentType(
      resolveArtifactContentType(artifact, handler),
    );
  }

  /**
   * Whether the public `/raw` route can serve bytes for this share at all —
   * true when there's a top-level stored file OR a handler-declared primary
   * file in the payload. Drives whether the projection mints a `fileUrl`.
   */
  async sharedArtifactHasServableFile(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
  ): Promise<boolean> {
    if (artifact.storageKey) {
      return true;
    }
    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);
    return Boolean(handler?.resolvePrimaryFile?.({ artifact }));
  }

  async sharedArtifactHasPreview(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
  ) {
    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);
    const media = handler?.resolveVersionMedia?.({ artifact });
    return Boolean(media?.coverImage || resolveArtifactPreviewImage(artifact));
  }

  /**
   * A capability-sanitized payload the public share page can client-render, or
   * null when the type has none. Delegated to the handler's `buildPublicPayload`
   * so the host never inspects payload shape; `assetUrl` maps a sub-asset file
   * name to the token-scoped public asset route the handler rewrites into the
   * payload.
   */
  async buildSharedArtifactPublicPayload(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
    assetUrl: (fileName: string) => string,
  ): Promise<Record<string, unknown> | null> {
    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);
    return handler?.buildPublicPayload?.({ artifact, assetUrl }) ?? null;
  }

  /**
   * Sub-asset bytes (narration, images) for a *share*-authorized artifact,
   * resolved by file name through the same handler path the authenticated asset
   * route uses. No per-user check: the caller (the public share route) has
   * already validated a live share token, which is the access grant. The
   * content type is corrected from the bytes for the same reason `getArtifactAsset`
   * does it (legacy narration is WAV mislabeled `audio/mpeg`).
   */
  async getSharedArtifactAsset(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
    fileName: string,
  ) {
    const registry = await loadArtifactViewHandlerRegistry();
    const asset = resolveArtifactAsset(
      artifact,
      fileName,
      registry.handlerFor(artifact.artifactType),
    );
    if (!asset) {
      throw new ContentError(
        404,
        "ARTIFACT_ASSET_NOT_FOUND",
        "Artifact asset not found",
      );
    }
    const body = await downloadArtifactObject({
      bucket: asset.storageBucket,
      key: asset.storageKey,
    });
    return {
      body,
      contentType: correctAudioContentTypeFromBytes(body, asset.contentType),
      fileName: asset.fileName,
    };
  }

  /** Preview-image bytes for a share-authorized artifact, or null if none. */
  async getSharedArtifactPreview(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
  ) {
    const registry = await loadArtifactViewHandlerRegistry();
    if (registry.handlerFor(artifact.artifactType)?.resolveVersionMedia) {
      return null;
    }
    const previewImage = resolveArtifactPreviewImage(artifact);
    if (!previewImage) {
      return null;
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
    const { artifact } = await this.requireViewableArtifact(input);
    const registry = await loadArtifactViewHandlerRegistry();
    const asset = resolveArtifactAsset(
      artifact,
      input.fileName,
      registry.handlerFor(artifact.artifactType),
    );
    if (!asset) {
      throw new ContentError(
        404,
        "ARTIFACT_ASSET_NOT_FOUND",
        "Artifact asset not found",
      );
    }

    const body = await downloadArtifactObject({
      bucket: asset.storageBucket,
      key: asset.storageKey,
    });
    return {
      body,
      // Backfill: legacy narration is PCM/WAV stored under `audio/mpeg`/.mp3
      // (the TTS streamed WAV even though mp3 was requested). Served with the
      // wrong type, the browser preview's <audio> feeds PCM to its MP3 decoder
      // and stutters + desyncs. Correct the type from the bytes so already
      // stored tracks play right without a re-render — scoped to audio assets
      // so a real `ftyp` mp4 video is never re-typed as audio.
      contentType: correctAudioContentTypeFromBytes(body, asset.contentType),
      fileName: asset.fileName,
    };
  }
}

/**
 * When a served asset is declared as some `audio/*` type but its bytes are a
 * different, identifiable audio container, serve the type the bytes actually
 * are. Only audio-declared assets are considered, so a video `ftyp` mp4 (which
 * shares the container-sniff signature) is never touched.
 */
function correctAudioContentTypeFromBytes(
  body: Uint8Array,
  declared: string,
): string {
  const normalized = normalizeMimeType(declared);
  if (!normalized.startsWith("audio/")) {
    return declared;
  }
  const sniffed = sniffAudioMimeType(body);
  return sniffed && sniffed !== normalized ? sniffed : declared;
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
  resolveByteRange,
  isArtifactOwnedStorageKey,
};
