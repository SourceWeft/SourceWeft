import type { ArtifactResource } from "@sourceweft/contracts/artifact-urls";
import { projectArtifactVersionFiles } from "../artifacts/version-files";
import type { PublicSharedArtifact, ShareLink } from "@sourceweft/contracts";
import { compactArtifactText } from "@sourceweft/contracts/artifact-files";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { workspaceService } from "../workspace";
import { canViewContent } from "../workspace/content-visibility";
import { teamAuditService } from "../team-audit";
import { contentArtifactsService } from "../artifacts";
import { findArtifactRecord } from "../artifacts/repository";
import {
  createShareLink,
  findActiveShareByTarget,
  findLiveShareByToken,
  incrementShareViewCount,
  revokeShareLink,
  revokeShareLinksForThreadArtifacts,
  updateShareLink,
  type ShareLinkRow,
} from "./store";

export type ShareMutationResult<T> =
  { ok: true; value: T } | { ok: false; reason: "not_found" | "forbidden" };

/**
 * Absolute, copy-pasteable link a viewer opens. The token is the entire access
 * grant, so — like Claude/NotebookLM public links — the path is just the opaque
 * id with no title slug: nothing about the content leaks into the URL.
 */
function shareUrl(token: string) {
  return `${config.auth.webBaseUrl}/artifact/${token}`;
}

/** Public backend endpoints the share page and its iframe fetch. */
function publicRawUrl(token: string) {
  return `${config.auth.baseUrl}/v1/public/shares/${token}/raw`;
}
function publicPreviewUrl(token: string) {
  return `${config.auth.baseUrl}/v1/public/shares/${token}/preview`;
}
function publicVersionMediaUrl(
  token: string,
  artifactVersionId: string,
  resource: "video" | "cover",
) {
  return `${config.auth.baseUrl}/v1/public/shares/${encodeURIComponent(token)}/versions/${encodeURIComponent(artifactVersionId)}/media/${resource}`;
}
/** Token-scoped public URL for a sub-asset (narration, image) of a shared artifact. */
function publicShareAssetUrl(token: string, fileName: string) {
  return `${config.auth.baseUrl}/v1/public/shares/${token}/assets/${encodeURIComponent(fileName)}`;
}

function toShareLink(row: ShareLinkRow): ShareLink {
  return {
    token: row.token,
    url: shareUrl(row.token),
    targetType: row.targetType as ShareLink["targetType"],
    targetId: row.targetId,
    isPublic: row.isPublic,
    noindex: row.noindex,
    accessLevel: row.accessLevel as ShareLink["accessLevel"],
    viewCount: row.viewCount,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class SharingService {
  /**
   * Resolves the artifact for a share operation and checks that the actor may
   * publish it. Publishing is deliberately narrow — the creator, or a content
   * workspace admin, and only when that actor can also *view* the artifact —
   * mirroring "only someone who can view an item may change its exposure".
   * Container admins (org owners, container-only admins) deliberately gain no
   * publish right over content they are walled out of. Returns a discriminated
   * failure rather than throwing so routes map it to a status.
   */
  private async requireShareableArtifact(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }): Promise<
    | {
        ok: true;
        teamId: string;
        artifact: NonNullable<Awaited<ReturnType<typeof findArtifactRecord>>>;
      }
    | { ok: false; reason: "not_found" | "forbidden" }
  > {
    const access = await workspaceService.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    if (!access || access.role === null) {
      return { ok: false, reason: "not_found" };
    }

    const artifact = await findArtifactRecord({
      teamId: access.organizationId,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    });
    if (!artifact) {
      return { ok: false, reason: "not_found" };
    }

    // Row-level visibility first: a private artifact belonging to another
    // member is reported absent, so its existence stays private and no
    // container admin can reach it by id (mirrors the view/delete paths).
    if (!canViewContent(input.userId, artifact)) {
      return { ok: false, reason: "not_found" };
    }

    const isCreator = artifact.createdBy === input.userId;
    if (!isCreator && !workspaceService.canAdministerContent(access)) {
      return { ok: false, reason: "forbidden" };
    }

    return { ok: true, teamId: access.organizationId, artifact };
  }

  async shareArtifact(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    noindex?: boolean;
    expiresAt?: string | null;
  }): Promise<ShareMutationResult<ShareLink>> {
    const resolved = await this.requireShareableArtifact(input);
    if (!resolved.ok) {
      return resolved;
    }

    const row = await createShareLink({
      teamId: resolved.teamId,
      workspaceId: input.workspaceId,
      targetType: "artifact",
      targetId: input.artifactId,
      accessLevel: "viewer",
      isPublic: true,
      noindex: input.noindex ?? false,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: input.userId,
    });

    await teamAuditService.record({
      teamId: resolved.teamId,
      actorUserId: input.userId,
      action: "artifact.shared",
      targetType: "artifact",
      targetId: input.artifactId,
      metadata: { token: row.token, noindex: row.noindex },
    });

    return { ok: true, value: toShareLink(row) };
  }

  async getArtifactShare(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }): Promise<ShareMutationResult<ShareLink | null>> {
    const resolved = await this.requireShareableArtifact(input);
    if (!resolved.ok) {
      return resolved;
    }

    const row = await findActiveShareByTarget({
      targetType: "artifact",
      targetId: input.artifactId,
    });

    return { ok: true, value: row ? toShareLink(row) : null };
  }

  async updateArtifactShare(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    noindex?: boolean;
    expiresAt?: string | null;
  }): Promise<ShareMutationResult<ShareLink>> {
    const resolved = await this.requireShareableArtifact(input);
    if (!resolved.ok) {
      return resolved;
    }

    const row = await updateShareLink({
      targetType: "artifact",
      targetId: input.artifactId,
      noindex: input.noindex,
      expiresAt:
        input.expiresAt === undefined
          ? undefined
          : input.expiresAt
            ? new Date(input.expiresAt)
            : null,
    });

    if (!row) {
      return { ok: false, reason: "not_found" };
    }

    return { ok: true, value: toShareLink(row) };
  }

  async revokeArtifactShare(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
  }): Promise<ShareMutationResult<null>> {
    const resolved = await this.requireShareableArtifact(input);
    if (!resolved.ok) {
      return resolved;
    }

    const revoked = await revokeShareLink({
      targetType: "artifact",
      targetId: input.artifactId,
    });

    if (revoked) {
      await teamAuditService.record({
        teamId: resolved.teamId,
        actorUserId: input.userId,
        action: "artifact.share_revoked",
        targetType: "artifact",
        targetId: input.artifactId,
      });
    }

    return { ok: true, value: null };
  }

  /**
   * Proactive counterpart to the serve-path private gate: flipping a thread to
   * private revokes every live share of its artifacts, so a later flip back to
   * workspace never silently re-arms an old public token — re-exposure requires
   * a fresh, deliberate publish (which mints a new token). No per-share authz
   * here: the caller has already authorized the visibility change itself, and
   * withdrawing exposure is strictly narrowing. Audited per revoked artifact
   * like a manual revoke, with the trigger recorded.
   */
  async revokeSharesForPrivatedThread(input: {
    teamId: string;
    workspaceId: string;
    threadId: string;
    actorUserId: string;
  }): Promise<number> {
    const artifactIds = await revokeShareLinksForThreadArtifacts({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    });

    for (const artifactId of artifactIds) {
      await teamAuditService.record({
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        action: "artifact.share_revoked",
        targetType: "artifact",
        targetId: artifactId,
        metadata: { reason: "thread_visibility_private" },
      });
    }

    return artifactIds.length;
  }

  /**
   * Public read for `/s/:token`. Returns the narrow projection a viewer needs,
   * or null when the token does not resolve to a live, unexpired artifact
   * share. Counts the view as a side effect, best-effort.
   */
  async resolvePublicArtifact(
    token: string,
  ): Promise<PublicSharedArtifact | null> {
    const share = await findLiveShareByToken(token);
    if (!share || share.targetType !== "artifact" || !share.isPublic) {
      return null;
    }

    const artifact = await findArtifactRecord({
      teamId: share.teamId,
      workspaceId: share.workspaceId ?? "",
      artifactId: share.targetId,
    });
    // A live public share IS the deliberate public grant — an axis orthogonal to
    // the artifact's workspace `visibility`. Exposure is withdrawn by REVOKING
    // the share, never by the visibility flag: turning a thread private revokes
    // its artifacts' shares *before* they inherit the private label (see
    // `updateThreadVisibility`), so "private ⟹ no live share" holds. We
    // therefore serve on the live share and only require the bytes to exist
    // (`ready`); a private-but-still-live share means it was deliberately
    // published from a private thread, which is exactly what we honor here.
    if (!artifact || artifact.status !== "ready") {
      return null;
    }

    const fileVersion =
      await contentArtifactsService.getSharedCurrentVersionFiles(artifact);
    if (fileVersion) {
      const versionQuery = `artifactVersionId=${encodeURIComponent(fileVersion.versionId)}`;
      const url = (resource: ArtifactResource): string | null => {
        switch (resource.kind) {
          case "file":
            return `${publicRawUrl(token)}?${versionQuery}`;
          case "download":
            return `${publicRawUrl(token)}?download=1&${versionQuery}`;
          case "previewImage":
            return `${publicPreviewUrl(token)}?${versionQuery}`;
          case "asset":
            return `${publicShareAssetUrl(token, resource.fileName)}?${versionQuery}`;
          case "sourceJson":
            return null;
        }
      };
      const files =
        projectArtifactVersionFiles({
          filesJson: fileVersion.filesJson,
          url,
        }) ?? [];
      const payload =
        await contentArtifactsService.buildSharedArtifactPublicPayload(
          { ...artifact, payloadJson: fileVersion.contentJson },
          (fileName) => url({ kind: "asset", fileName })!,
        );
      const primary = files.find((file) => file.role === "primary");
      return {
        token,
        artifactType: artifact.artifactType,
        title: artifact.title,
        fileUrl: primary?.url ?? null,
        downloadUrl: primary?.downloadUrl ?? null,
        inlinePreviewable:
          await contentArtifactsService.isSharedArtifactInlineRenderable(
            artifact,
          ),
        payload: payload
          ? {
              ...payload,
              artifactVersionId: fileVersion.versionId,
              versionNo: fileVersion.versionNo,
              versionFiles: files,
            }
          : null,
        previewImageUrl:
          files.find((file) => file.role === "preview")?.url ?? null,
        description: null,
        viewCount: share.viewCount,
        noindex: share.noindex,
        createdAt: share.createdAt.toISOString(),
      };
    }
    const exactMedia =
      await contentArtifactsService.getSharedCurrentArtifactVersionMedia(
        artifact,
      );
    const hasPreview = exactMedia
      ? Boolean(exactMedia.media.coverImage)
      : await contentArtifactsService.sharedArtifactHasPreview(artifact);
    const inlinePreviewable = exactMedia
      ? true
      : await contentArtifactsService.isSharedArtifactInlineRenderable(
          artifact,
        );
    // A servable file can be the top-level stored file OR a capability's
    // payload-stored primary file (e.g. a video presentation's rendered mp4),
    // so `fileUrl` is not gated on the top-level `storageKey` alone.
    const hasServableFile = exactMedia
      ? true
      : await contentArtifactsService.sharedArtifactHasServableFile(artifact);
    // A capability-sanitized payload for artifact types that still need a
    // client-side renderer. Video Presentation intentionally returns null and
    // uses the trusted `/raw` media path instead.
    const publicPayload = exactMedia
      ? null
      : await contentArtifactsService.buildSharedArtifactPublicPayload(
          artifact,
          (fileName) => publicShareAssetUrl(token, fileName),
        );

    // Content-derived SEO/social description, from the preview image's alt
    // caption only — already-shown, non-sensitive text. Never `promptText` or
    // any payload field. Null when there's no usable caption; the page then
    // falls back to a title + type sentence.
    const previewMeta = artifact.previewMetadataJson as
      Record<string, unknown> | null | undefined;
    const altText =
      previewMeta && typeof previewMeta.altText === "string"
        ? previewMeta.altText.trim()
        : "";
    const description = altText ? compactArtifactText(altText, 160) : null;

    // Curated, allow-list projection. The internal `payloadJson` is never
    // exposed: for real artifact types it embeds workspace-scoped URLs
    // (`/v1/workspaces/...`), `jobId`, `sourceJson`, and storage keys/buckets,
    // all of which an anonymous token holder could otherwise harvest. The
    // public page renders solely from `fileUrl` (the sandboxed /raw bytes) and
    // the social-card metadata below, so nothing internal needs to cross the
    // boundary. Add a field here only when the public renderer truly consumes
    // it, and only after sanitizing it.
    return {
      token,
      artifactType: artifact.artifactType,
      title: exactMedia?.media.title ?? artifact.title,
      fileUrl: exactMedia
        ? publicVersionMediaUrl(token, exactMedia.versionId, "video")
        : hasServableFile
          ? publicRawUrl(token)
          : null,
      downloadUrl: exactMedia
        ? `${publicVersionMediaUrl(token, exactMedia.versionId, "video")}?download=1`
        : hasServableFile
          ? `${publicRawUrl(token)}?download=1`
          : null,
      inlinePreviewable,
      payload: publicPayload,
      previewImageUrl: exactMedia?.media.coverImage
        ? publicVersionMediaUrl(token, exactMedia.versionId, "cover")
        : hasPreview
          ? publicPreviewUrl(token)
          : null,
      description,
      viewCount: share.viewCount,
      noindex: share.noindex,
      createdAt: share.createdAt.toISOString(),
    };
  }

  /**
   * Backing data for the public raw/preview byte routes, and where a view is
   * counted. Counting on the actual byte serve (not the JSON projection) keeps
   * the count honest — the share page fetches the projection twice per load
   * (metadata + render), but the artifact bytes load once — and only counts a
   * view when content was really delivered.
   */
  async resolvePublicArtifactBytes(
    token: string,
    options?: { countView?: boolean },
  ) {
    const share = await findLiveShareByToken(token);
    if (!share || share.targetType !== "artifact" || !share.isPublic) {
      return null;
    }
    const artifact = await findArtifactRecord({
      teamId: share.teamId,
      workspaceId: share.workspaceId ?? "",
      artifactId: share.targetId,
    });
    // Serve on the live public share, not the visibility flag — see
    // resolvePublicArtifact.
    if (!artifact || artifact.status !== "ready") {
      return null;
    }

    if (options?.countView) {
      void incrementShareViewCount(token).catch((error) => {
        logger.warn("share_view_count_increment_failed", {
          token,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return { share, artifact };
  }
}

export const sharingService = new SharingService();
