import type { PublicSharedChat, ThreadShare } from "@sourceweft/contracts";
import { logger } from "../../../shared/logger";
import { findArtifactRecord } from "../../artifacts/repository";
import type { ShareMutationResult } from "../../sharing";
import { shareUrl, toShareLink } from "../../sharing/service";
import {
  createShareLink,
  findActiveShareByTarget,
  findLiveShareByToken,
  findPubliclySharedArtifactIds,
  revokeShareLink,
  updateShareLink,
  type ShareLinkRow,
} from "../../sharing/store";
import {
  downloadArtifactObject,
  downloadChatImageObject,
} from "../../sources/storage";
import { teamAuditService } from "../../team-audit";
import { workspaceService } from "../../workspace";
import {
  canViewContent,
  canViewThread,
} from "../../workspace/content-visibility";
import type { ThreadRecord } from "../../content/types";
import { resolvePersona } from "../agent";
import { findActiveChatThreadRun } from "../durable/repository";
import type { ArtifactType } from "../export/labels";
import {
  collectMessageArtifactIds,
  selectExportMessages,
} from "../export/messages";
import { listMessageRecordsByThread } from "../message-repository";
import { isHostOwnedThreadOrigin } from "../thread/host-owned";
import { findThreadRecord } from "../thread/repository";
import {
  deleteThreadShareSnapshot,
  findThreadShareSnapshot,
  upsertThreadShareSnapshot,
} from "./repository";
import {
  buildChatSnapshot,
  type ChatSnapshot,
  type SnapshotArtifact,
} from "./snapshot";

type ThreadShareInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
};

type Scope = { teamId: string; workspaceId: string };

function toThreadShare(row: ShareLinkRow, takenAt: Date): ThreadShare {
  return { ...toShareLink(row), snapshotTakenAt: takenAt.toISOString() };
}

/** Where the public route serves image `n` of a shared chat. */
function publicImageUrl(apiBaseUrl: string, token: string, n: number) {
  return `${apiBaseUrl}/v1/public/shares/${token}/chat/images/${n}`;
}

function payloadMimeType(payload: unknown): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const value = (payload as Record<string, unknown>).mimeType;
    return typeof value === "string" ? value : null;
  }
  return null;
}

/** A live, public thread share and its snapshot for a token, or null. */
async function findPublicSnapshot(token: string) {
  const share = await findLiveShareByToken(token);
  if (!share || share.targetType !== "thread" || !share.isPublic) {
    return null;
  }
  const stored = await findThreadShareSnapshot(share.id);
  if (!stored || stored.threadId !== share.targetId) {
    return null;
  }
  return { share, snapshot: stored.snapshot };
}

export class ThreadShareService {
  /**
   * Resolves the chat for a share operation and checks that the actor may
   * publish it, mirroring `requireShareableArtifact`: the chat must be visible
   * to the actor (otherwise absent), a top-level chat (a sub-agent chat is
   * absent), and the actor its creator or a content admin (otherwise
   * forbidden).
   */
  private async requireShareableThread(
    input: ThreadShareInput,
  ): Promise<
    | { ok: true; scope: Scope; thread: ThreadRecord }
    | { ok: false; reason: "not_found" | "forbidden" }
  > {
    const access = await workspaceService.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    if (!access || access.role === null) {
      return { ok: false, reason: "not_found" };
    }

    const scope = {
      teamId: access.organizationId,
      workspaceId: input.workspaceId,
    };
    const thread = await findThreadRecord({
      ...scope,
      threadId: input.threadId,
    });
    if (!thread || !canViewThread(input.userId, thread)) {
      return { ok: false, reason: "not_found" };
    }
    // A sub-agent's chat, and a workspace assistant's own conversations (the
    // Router's work log holds every member's messages), are never shared.
    if (
      thread.parentThreadId !== null ||
      thread.origin === "subagent" ||
      isHostOwnedThreadOrigin(thread.origin)
    ) {
      return { ok: false, reason: "not_found" };
    }

    const isCreator = thread.createdBy === input.userId;
    if (!isCreator && !workspaceService.canAdministerContent(access)) {
      return { ok: false, reason: "forbidden" };
    }

    return { ok: true, scope, thread };
  }

  /**
   * Freezes the chat as the sharer sees it now: the export's message
   * selection, and only the reply artifacts that are ready and visible to the
   * sharer.
   */
  private async takeSnapshot(input: {
    scope: Scope;
    thread: ThreadRecord;
    userId: string;
    takenAt: Date;
  }): Promise<ChatSnapshot> {
    const { scope, thread } = input;
    const [stored, activeRun, persona] = await Promise.all([
      listMessageRecordsByThread({ ...scope, threadId: thread.id }),
      findActiveChatThreadRun({ ...scope, threadId: thread.id }),
      resolvePersona({ ...scope, personaId: thread.personaId }),
    ]);
    const activeAssistantMessageId = activeRun?.assistantMessageId ?? null;

    const artifactIds = new Set<string>();
    for (const message of selectExportMessages(
      stored,
      activeAssistantMessageId,
    )) {
      if (message.role === "assistant") {
        for (const id of collectMessageArtifactIds(message.metadata)) {
          artifactIds.add(id);
        }
      }
    }

    const artifacts = new Map<string, SnapshotArtifact>();
    await Promise.all(
      [...artifactIds].map(async (artifactId) => {
        const artifact = await findArtifactRecord({ ...scope, artifactId });
        if (
          !artifact ||
          artifact.status !== "ready" ||
          !canViewContent(input.userId, artifact)
        ) {
          return;
        }
        artifacts.set(artifactId, {
          kind: artifact.artifactType as ArtifactType,
          title: artifact.title?.trim() || artifactId,
          mimeType: payloadMimeType(artifact.payloadJson),
        });
      }),
    );

    return buildChatSnapshot({
      title: thread.title,
      assistantName: persona?.name ?? null,
      takenAt: input.takenAt,
      messages: stored,
      activeAssistantMessageId,
      artifacts,
    });
  }

  /** The chat's live share, or null when it is not shared. */
  async getThreadShare(
    input: ThreadShareInput,
  ): Promise<ShareMutationResult<ThreadShare | null>> {
    const resolved = await this.requireShareableThread(input);
    if (!resolved.ok) {
      return resolved;
    }

    const row = await findActiveShareByTarget({
      targetType: "thread",
      targetId: input.threadId,
    });
    // A link without a snapshot serves nothing publicly (a share that failed
    // half-way); report it as not shared so sharing again completes it.
    const stored = row ? await findThreadShareSnapshot(row.id) : null;
    return {
      ok: true,
      value: row && stored ? toThreadShare(row, stored.takenAt) : null,
    };
  }

  /**
   * Shares the chat, or re-takes the snapshot on the existing live link (same
   * token) when it is already shared. `noindex` applies only when creating.
   */
  async shareThread(
    input: ThreadShareInput & { noindex?: boolean },
  ): Promise<ShareMutationResult<ThreadShare>> {
    const resolved = await this.requireShareableThread(input);
    if (!resolved.ok) {
      return resolved;
    }

    const takenAt = new Date();
    // Built before the link exists so a failure leaves nothing published.
    const snapshot = await this.takeSnapshot({
      scope: resolved.scope,
      thread: resolved.thread,
      userId: input.userId,
      takenAt,
    });

    const existing = await findActiveShareByTarget({
      targetType: "thread",
      targetId: input.threadId,
    });
    const row =
      existing ??
      (await createShareLink({
        teamId: resolved.scope.teamId,
        workspaceId: resolved.scope.workspaceId,
        targetType: "thread",
        targetId: input.threadId,
        accessLevel: "viewer",
        isPublic: true,
        noindex: input.noindex ?? true,
        expiresAt: null,
        createdBy: input.userId,
      }));

    await upsertThreadShareSnapshot({
      shareLinkId: row.id,
      teamId: resolved.scope.teamId,
      workspaceId: resolved.scope.workspaceId,
      threadId: input.threadId,
      snapshot,
      takenAt,
    });

    await teamAuditService.record({
      teamId: resolved.scope.teamId,
      actorUserId: input.userId,
      action: existing ? "thread.share_updated" : "thread.shared",
      targetType: "thread",
      targetId: input.threadId,
      metadata: { token: row.token, noindex: row.noindex },
    });

    return { ok: true, value: toThreadShare(row, takenAt) };
  }

  async updateThreadShare(
    input: ThreadShareInput & { noindex: boolean },
  ): Promise<ShareMutationResult<ThreadShare>> {
    const resolved = await this.requireShareableThread(input);
    if (!resolved.ok) {
      return resolved;
    }

    const row = await updateShareLink({
      targetType: "thread",
      targetId: input.threadId,
      noindex: input.noindex,
    });
    const stored = row ? await findThreadShareSnapshot(row.id) : null;
    if (!row || !stored) {
      return { ok: false, reason: "not_found" };
    }

    await teamAuditService.record({
      teamId: resolved.scope.teamId,
      actorUserId: input.userId,
      action: "thread.share_updated",
      targetType: "thread",
      targetId: input.threadId,
      metadata: { token: row.token, noindex: row.noindex },
    });

    return { ok: true, value: toThreadShare(row, stored.takenAt) };
  }

  /** Stops sharing: the link is revoked and its snapshot deleted. */
  async revokeThreadShare(
    input: ThreadShareInput,
  ): Promise<ShareMutationResult<true>> {
    const resolved = await this.requireShareableThread(input);
    if (!resolved.ok) {
      return resolved;
    }

    const live = await findActiveShareByTarget({
      targetType: "thread",
      targetId: input.threadId,
    });
    const revoked = await revokeShareLink({
      targetType: "thread",
      targetId: input.threadId,
    });
    if (live) {
      await deleteThreadShareSnapshot(live.id);
    }

    if (revoked) {
      await teamAuditService.record({
        teamId: resolved.scope.teamId,
        actorUserId: input.userId,
        action: "thread.share_revoked",
        targetType: "thread",
        targetId: input.threadId,
      });
    }

    return { ok: true, value: true };
  }

  /**
   * Public read of a shared chat: the frozen snapshot with image references
   * turned into public image URLs, and each artifact card linked only while
   * that artifact has its own live public share. Null unless the token is a
   * live, public thread share with a snapshot. Counting the view is the
   * route's job.
   */
  async resolvePublicChat(
    token: string,
    apiBaseUrl: string,
  ): Promise<PublicSharedChat | null> {
    const found = await findPublicSnapshot(token);
    if (!found) {
      return null;
    }
    const { share, snapshot } = found;

    const publicArtifacts = await findPubliclySharedArtifactIds([
      ...new Set(
        snapshot.messages.flatMap((message) =>
          message.artifacts.map((artifact) => artifact.artifactId),
        ),
      ),
    ]);
    const imageUrl = (n: number) => publicImageUrl(apiBaseUrl, token, n);

    return {
      title: snapshot.title,
      takenAt: snapshot.takenAt,
      assistantName: snapshot.assistantName,
      noindex: share.noindex,
      messages: snapshot.messages.map((message) => ({
        role: message.role,
        createdAt: message.createdAt,
        content: message.content.replace(
          /\]\(sw-image:(\d+)\)/g,
          (_match, n: string) => `](${imageUrl(Number(n))})`,
        ),
        stopped: message.stopped,
        citations: message.citations,
        images: message.images.map((image) => ({
          name: image.name,
          url: imageUrl(image.n),
        })),
        artifacts: message.artifacts.map((artifact) => {
          const artifactToken = publicArtifacts.get(artifact.artifactId);
          return {
            kind: artifact.kind,
            title: artifact.title,
            publicUrl: artifactToken
              ? shareUrl("artifact", artifactToken)
              : null,
          };
        }),
      })),
    };
  }

  /**
   * Bytes of image `n` of a shared chat. An attachment is read by its recorded
   * storage location; a generated image only while its artifact still exists,
   * is ready, and lives in the share's workspace. Null on any miss or storage
   * failure.
   */
  async resolvePublicChatImage(
    token: string,
    n: number,
  ): Promise<{ body: Uint8Array; contentType: string } | null> {
    const found = await findPublicSnapshot(token);
    const image = found?.snapshot.images.find((entry) => entry.n === n);
    if (!found || !image) {
      return null;
    }

    try {
      if (image.source === "attachment") {
        return {
          body: await downloadChatImageObject({
            bucket: image.bucket,
            key: image.key,
          }),
          contentType: image.mimeType,
        };
      }

      const artifact = await findArtifactRecord({
        teamId: found.share.teamId,
        workspaceId: found.share.workspaceId ?? "",
        artifactId: image.artifactId,
      });
      if (!artifact || artifact.status !== "ready" || !artifact.storageKey) {
        return null;
      }
      return {
        body: await downloadArtifactObject({
          bucket: artifact.storageBucket,
          key: artifact.storageKey,
        }),
        contentType:
          payloadMimeType(artifact.payloadJson) ??
          image.mimeType ??
          "application/octet-stream",
      };
    } catch (error) {
      logger.warn("Shared chat image unavailable", {
        shareLinkId: found.share.id,
        n,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export const threadShareService = new ThreadShareService();
