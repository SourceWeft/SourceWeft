import type { PublicSharedArtifact, ShareLink } from "@sourceweft/contracts";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { workspaceService } from "../workspace";
import { teamAuditService } from "../team-audit";
import { findArtifactRecord } from "../artifacts/repository";
import {
  createShareLink,
  findActiveShareByTarget,
  findLiveShareByToken,
  incrementShareViewCount,
  revokeShareLink,
  updateShareLink,
  type ShareLinkRow,
} from "./store";

export type ShareMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "forbidden" };

/** Absolute, copy-pasteable link a viewer opens. */
function shareUrl(token: string) {
  return `${config.auth.webBaseUrl}/s/${token}`;
}

/** Public backend endpoints the share page and its iframe fetch. */
function publicRawUrl(token: string) {
  return `${config.auth.baseUrl}/v1/public/shares/${token}/raw`;
}
function publicPreviewUrl(token: string) {
  return `${config.auth.baseUrl}/v1/public/shares/${token}/preview`;
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
   * publish it. Publishing is deliberately narrow — the creator, or a workspace
   * admin — mirroring "only the author decides an item's visibility". Returns a
   * discriminated failure rather than throwing so routes map it to a status.
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

    const isCreator = artifact.createdBy === input.userId;
    if (!isCreator && !workspaceService.canAdministerContainer(access)) {
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
    if (!artifact || artifact.status !== "ready") {
      return null;
    }

    const hasPreview = Boolean(artifact.previewStorageKey);

    return {
      token,
      artifactType: artifact.artifactType,
      title: artifact.title,
      fileUrl: artifact.storageKey ? publicRawUrl(token) : null,
      previewImageUrl: hasPreview ? publicPreviewUrl(token) : null,
      payloadJson: artifact.payloadJson,
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
