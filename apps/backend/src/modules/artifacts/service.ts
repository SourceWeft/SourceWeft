import {
  ARTIFACT_MIME_TYPES,
  extensionForMimeType,
  isInlinePreviewableMimeType,
} from "@sourceweft/contracts/artifact-files";
import { buildArtifactPreviewUrl as buildArtifactPreviewPageUrl } from "@sourceweft/contracts/artifact-urls";
import type {
  ArtifactCapabilities,
  ArtifactViewHandler,
} from "@sourceweft/contracts";
import { requireContentWorkspace } from "../workspace/guards";
import { workspaceService } from "../workspace";
import { canViewContent } from "../workspace/content-visibility";
import { ContentError } from "../content/errors";
import {
  deleteArtifactObject,
  downloadArtifactObject,
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
  listArtifactRecords,
} from "./repository";
import { loadArtifactViewHandlerRegistry } from "./view-handlers";

type ArtifactRecord = Awaited<ReturnType<typeof findArtifactRecord>>;

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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
  const canRenderClientSide = Boolean(
    artifact && handler && artifact.status !== "failed",
  );
  return {
    canOpenFile: hasFile || canRenderClientSide,
    canDownloadFile: hasFile,
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

  private buildArtifactResponse(input: {
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>;
    workspaceId: string;
    handler?: ArtifactViewHandler | null;
    isPublic?: boolean;
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

    return {
      items: artifacts.items.map((artifact) =>
        this.buildArtifactResponse({
          artifact,
          workspaceId: workspace.id,
          handler: registry.handlerFor(artifact.artifactType),
          isPublic: publicArtifactIds.has(artifact.id),
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
    const { workspace, artifact } = await this.requireViewableArtifact(input);

    const registry = await loadArtifactViewHandlerRegistry();
    const publicArtifactIds = await findPubliclySharedArtifactIds([
      artifact.id,
    ]);

    return {
      artifact: this.buildArtifactResponse({
        artifact,
        workspaceId: workspace.id,
        handler: registry.handlerFor(artifact.artifactType),
        isPublic: publicArtifactIds.has(artifact.id),
      }),
    };
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
    if (!artifact.storageKey) {
      throw new ContentError(
        400,
        "ARTIFACT_FILE_MISSING",
        "Artifact has no stored file",
      );
    }

    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);

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
    if (!artifact.storageKey) {
      throw new ContentError(
        400,
        "ARTIFACT_FILE_MISSING",
        "Artifact has no stored file",
      );
    }
    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);
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

  /**
   * Whether the public share page can embed this artifact's bytes inline (vs.
   * falling back to its poster image). Handler-aware via the same content-type
   * resolution the `/raw` serve uses, so office decks (`.pptx`) etc. correctly
   * report false instead of rendering as a blank iframe.
   */
  async isSharedArtifactInlineRenderable(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
  ): Promise<boolean> {
    if (!artifact.storageKey) {
      return false;
    }
    const registry = await loadArtifactViewHandlerRegistry();
    const handler = registry.handlerFor(artifact.artifactType);
    return isBrowserRenderableContentType(
      resolveArtifactContentType(artifact, handler),
    );
  }

  /** Preview-image bytes for a share-authorized artifact, or null if none. */
  async getSharedArtifactPreview(
    artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>,
  ) {
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
