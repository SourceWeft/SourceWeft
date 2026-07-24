import { findCitationByMessageRank } from "../citations";
import { updateArtifactsVisibilityForThread } from "../artifacts/repository";
import { ContentError } from "../content/errors";
import type { MessageRecord } from "../content/types";
import { requireContentWorkspace } from "../workspace/guards";
import { workspaceService } from "../workspace";
import { canViewThread } from "../workspace/content-visibility";
import { normalizeContentTitle } from "../../shared/strings";
import {
  getMetadataNumber,
  getMetadataString,
  toObjectRecord,
} from "../sources/metadata";
import {
  createThreadRecord,
  deleteThreadRecord,
  findThreadRecord,
  findRecentThreadRecordByUser,
  listThreadRecordsByWorkspace,
  updateThreadChatPreferencesRecord,
  updateThreadModelSettingsRecord,
  updateThreadVisibilityRecord,
} from "./thread/repository";
import {
  listMessageRecordPageByThread,
  findMessageRecord,
  listMessageRecordsByThread,
} from "./message-repository";
import {
  DEFAULT_THREAD_CHAT_PREFERENCES,
  normalizeThreadChatPreferences,
  type ThreadChatPreferencesPatch,
} from "./chat-preferences";
import {
  mergeThreadModelSettings,
  normalizeThreadModelSettings,
  pruneUnavailableThreadModelAliases,
  resolveThreadModelSettingsSnapshots,
  validateThreadModelSettings,
} from "./model-settings";
import { decodeThreadsCursor, encodeThreadsCursor } from "./thread/cursor";
import { listThreadModelCatalog } from "./thread/model-catalog";
import { downloadChatImageObject } from "../sources/storage";
import { durableChatRunService } from "./durable/service";
import { findChatThreadRunByIdempotencyKey } from "./durable/repository";
import { streamThreadRoom } from "./durable/room-service";
import { readPresence } from "./durable/presence-store";
import { typingRateLimiter } from "./durable/typing-rate-limit";
import { publishThreadEvent } from "../../shared/notify-hub";
import {
  filterOrganizationMemberIds,
  findUserIdentitiesByIds,
} from "../workspace/store";
import type { ChatThreadRunMode } from "./durable/types";
import type { StreamThreadEventInput } from "./turn/types";
import { sanitizeThreadMessageMetadataForClient } from "./agent/turn/output-normalizer";
import type { ThreadChatPreferences } from "@sourceweft/contracts";

const DEFAULT_THREAD_PAGE_LIMIT = 20;

function decodeMessagesCursor(cursor: string | undefined) {
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

function findImagePart(input: { contentJson: unknown; imageId: string }) {
  const contentJson =
    input.contentJson && typeof input.contentJson === "object"
      ? (input.contentJson as { parts?: unknown })
      : {};
  if (!Array.isArray(contentJson.parts)) {
    return null;
  }

  for (const part of contentJson.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (
      record.type === "image" &&
      record.id === input.imageId &&
      typeof record.storageKey === "string" &&
      typeof record.mimeType === "string" &&
      typeof record.fileName === "string"
    ) {
      return {
        fileName: record.fileName,
        mimeType: record.mimeType,
        storageBucket:
          typeof record.storageBucket === "string"
            ? record.storageBucket
            : null,
        storageKey: record.storageKey,
      };
    }
  }

  return null;
}

function sanitizeClientMessageRecord(message: MessageRecord): MessageRecord {
  return {
    ...message,
    metadata: sanitizeThreadMessageMetadataForClient(message.metadata),
  };
}

function sanitizeClientMessagePage(input: {
  items: MessageRecord[];
  nextCursor: string | null;
}) {
  return {
    ...input,
    items: input.items.map(sanitizeClientMessageRecord),
  };
}

export type StartThreadTurnInput = {
  workspaceId: string;
  userId: string;
  title?: string;
  modelSettings?: {
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  };
  chatPreferences?: Partial<ThreadChatPreferences>;
  content: string;
  images?: StreamThreadEventInput["images"];
  mentionedSourceIds?: string[];
  sourceIds?: string[];
  tools?: StreamThreadEventInput["tools"];
  command?: StreamThreadEventInput["command"];
  invocation?: StreamThreadEventInput["invocation"];
  timezone?: string;
  idempotencyKey: string;
  llm?: StreamThreadEventInput["llm"];
  image?: StreamThreadEventInput["image"];
  vision?: StreamThreadEventInput["vision"];
  imageProfileAlias?: string | null;
  visionProfileAlias?: string | null;
};

class ContentThreadService {
  async listThreads(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
    cursor?: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const limit = input.limit ?? DEFAULT_THREAD_PAGE_LIMIT;
    const decodedCursor = input.cursor
      ? decodeThreadsCursor(input.cursor)
      : undefined;

    const items = await listThreadRecordsByWorkspace({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      viewerUserId: input.userId,
      limit: limit + 1,
      cursor: decodedCursor,
    });

    const pageItems = items.slice(0, limit);
    const hasMore = items.length > limit;
    const lastVisible = pageItems[pageItems.length - 1] ?? null;
    const nextCursor =
      hasMore && lastVisible
        ? encodeThreadsCursor({
            id: lastVisible.id,
            updatedAt: lastVisible.updatedAt,
          })
        : null;

    return { items: pageItems, nextCursor };
  }

  async getThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread || !canViewThread(input.userId, thread)) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    return { thread };
  }

  async deleteThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    // A plain editor may delete only their own threads; a content admin may
    // delete any thread visible to them. Resolve the caller's content-plane
    // standing to decide which.
    const access = await workspaceService.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const isContentAdmin = access
      ? workspaceService.canAdministerContent(access)
      : false;

    const deleted = await deleteThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      viewerUserId: input.userId,
      isContentAdmin,
    });

    if (!deleted) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    return {
      deleted: true as const,
      threadId: input.threadId,
    };
  }

  async updateThreadModelSettings(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread || !canViewThread(input.userId, thread)) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    const patch = {
      llmProfileAlias: input.llmProfileAlias,
      imageProfileAlias: input.imageProfileAlias,
      visionProfileAlias: input.visionProfileAlias,
    };
    if (
      patch.llmProfileAlias === undefined &&
      patch.imageProfileAlias === undefined &&
      patch.visionProfileAlias === undefined
    ) {
      throw new ContentError(
        400,
        "MODEL_SETTINGS_EMPTY_PATCH",
        "At least one model alias must be provided",
      );
    }

    const currentSettings = normalizeThreadModelSettings(thread.modelSettings);
    const sanitizedCurrentSettings =
      await pruneUnavailableThreadModelAliases(currentSettings);

    const nextSettings = await pruneUnavailableThreadModelAliases(
      mergeThreadModelSettings(sanitizedCurrentSettings, patch),
    );

    await validateThreadModelSettings(nextSettings);
    const resolvedNextSettings =
      await resolveThreadModelSettingsSnapshots(nextSettings);

    const updated = await updateThreadModelSettingsRecord({
      threadId: thread.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      modelSettings: resolvedNextSettings,
    });

    if (!updated) {
      throw new ContentError(
        500,
        "THREAD_UPDATE_FAILED",
        "Failed to update thread settings",
      );
    }

    return { thread: updated };
  }

  async updateThreadChatPreferences(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    chatPreferences: ThreadChatPreferencesPatch;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread || !canViewThread(input.userId, thread)) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    const updated = await updateThreadChatPreferencesRecord({
      threadId: thread.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      chatPreferences: input.chatPreferences,
    });

    if (!updated) {
      throw new ContentError(
        500,
        "THREAD_UPDATE_FAILED",
        "Failed to update thread chat preferences",
      );
    }

    return { thread: updated };
  }

  async updateThreadVisibility(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    visibility: "private" | "workspace";
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    // Scoped to the author in the repository. A thread the caller can see but
    // did not create returns null here, and that is intentional: reading a
    // shared thread does not grant the right to change who else can read it.
    const updated = await updateThreadVisibilityRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      viewerUserId: input.userId,
      visibility: input.visibility,
    });

    if (!updated) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    // Artifacts inherit thread visibility, so re-sharing/hiding a thread re-labels its artifacts.
    await updateArtifactsVisibilityForThread({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
      threadVisibility: input.visibility,
    });

    return { thread: updated };
  }

  async getInitialChatPreferences(input: {
    workspaceId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const recentThread = await findRecentThreadRecordByUser({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    });

    return {
      initialChatPreferences: recentThread
        ? normalizeThreadChatPreferences(recentThread.chatPreferences)
        : DEFAULT_THREAD_CHAT_PREFERENCES,
    };
  }

  async listThreadModelCatalog(input: { workspaceId: string; userId: string }) {
    return listThreadModelCatalog(input);
  }

  async createThread(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    modelSettings?: {
      llmProfileAlias?: string | null;
      imageProfileAlias?: string | null;
      visionProfileAlias?: string | null;
    };
    chatPreferences?: Partial<ThreadChatPreferences>;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const modelSettings = await pruneUnavailableThreadModelAliases(
      normalizeThreadModelSettings(input.modelSettings),
    );
    await validateThreadModelSettings(modelSettings);
    const resolvedModelSettings =
      await resolveThreadModelSettingsSnapshots(modelSettings);

    const thread = await createThreadRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeContentTitle(input.title, "New Thread"),
      createdBy: input.userId,
      modelSettings: resolvedModelSettings,
      chatPreferences: input.chatPreferences,
    });

    return { thread };
  }

  async startThreadTurn(input: StartThreadTurnInput) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const existingRun = await findChatThreadRunByIdempotencyKey({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      idempotencyKey: input.idempotencyKey,
    });
    if (existingRun) {
      if (existingRun.userId !== input.userId) {
        throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
      }
      const existingThread = await findThreadRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        threadId: existingRun.threadId,
      });
      if (!existingThread || !canViewThread(input.userId, existingThread)) {
        throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
      }
      return { thread: existingThread, run: existingRun };
    }

    const modelSettings = await pruneUnavailableThreadModelAliases(
      normalizeThreadModelSettings(input.modelSettings),
    );
    await validateThreadModelSettings(modelSettings);
    const resolvedModelSettings =
      await resolveThreadModelSettingsSnapshots(modelSettings);

    const thread = await createThreadRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeContentTitle(input.title, "New Thread"),
      createdBy: input.userId,
      modelSettings: resolvedModelSettings,
      chatPreferences: input.chatPreferences,
    });

    const mode: ChatThreadRunMode = "send";
    const request: StreamThreadEventInput = {
      workspaceId: input.workspaceId,
      threadId: thread.id,
      userId: input.userId,
      content: input.content,
      images: input.images,
      mentionedSourceIds: input.mentionedSourceIds,
      sourceIds: input.sourceIds,
      tools: input.tools,
      command: input.command,
      invocation: input.invocation,
      timezone: input.timezone,
      idempotencyKey: input.idempotencyKey,
      llm: input.llm,
      image: input.image,
      vision: input.vision,
      imageProfileAlias: input.imageProfileAlias,
      visionProfileAlias: input.visionProfileAlias,
    };

    const { run } = await durableChatRunService.getOrCreateRun({
      workspaceId: input.workspaceId,
      threadId: thread.id,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      mode,
      request,
    });

    return { thread, run };
  }

  async getCitationDetail(input: {
    workspaceId: string;
    messageId: string;
    rank: number;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const citation = await findCitationByMessageRank({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      messageId: input.messageId,
      rank: input.rank,
    });

    if (!citation) {
      throw new ContentError(404, "CITATION_NOT_FOUND", "Citation not found");
    }

    const snapshot = toObjectRecord(citation.metadataJson);
    const sourceTitleSnapshot = getMetadataString(snapshot, "sourceTitle");
    const chunkNoSnapshot = getMetadataNumber(snapshot, "chunkNo");
    const excerptSnapshot = getMetadataString(snapshot, "excerpt");
    const contentSnapshot = getMetadataString(snapshot, "content");

    return {
      citation: {
        citation: citation.citationKey,
        score: citation.score,
        sourceId: citation.sourceId,
        sourceTitle: citation.sourceTitle ?? sourceTitleSnapshot,
        documentId: citation.documentId,
        chunkId:
          citation.chunkId ??
          citation.externalUri ??
          `external:${citation.citationKey}`,
        chunkNo: chunkNoSnapshot,
        externalUri: citation.externalUri,
        excerpt:
          citation.quoteText ?? citation.chunkContent ?? excerptSnapshot ?? "",
        content: contentSnapshot,
      },
    };
  }

  async listThreadMessages(input: {
    cursor?: string;
    after?: string;
    include?: string;
    limit?: number;
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread || !canViewThread(input.userId, thread)) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }
    const includeFields = new Set(
      (input.include ?? "metadata,contentJson,citations")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
    const include = {
      citations: includeFields.has("citations"),
      contentJson: includeFields.has("contentJson"),
      metadata: includeFields.has("metadata"),
    };

    if (input.limit) {
      const page = await listMessageRecordPageByThread({
        include,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        threadId: thread.id,
        before: decodeMessagesCursor(input.cursor),
        after: decodeMessagesCursor(input.after),
        limit: input.limit,
      });

      return sanitizeClientMessagePage(page);
    }

    const items = await listMessageRecordsByThread({
      include,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
    });

    return sanitizeClientMessagePage({ items, nextCursor: null });
  }

  /**
   * Authorize and open a live thread room (SSE). Authorization is identical to
   * `listThreadMessages` — a workspace member who can see the thread — and is
   * performed up front so a non-viewer gets a clean 404, never a half-open
   * event-stream. The returned generator subscribes to the NotifyHub and yields
   * thin wake-up frames; the client reconciles content over REST.
   */
  async openThreadRoom(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    signal?: AbortSignal;
  }): Promise<AsyncGenerator<string>> {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread || !canViewThread(input.userId, thread)) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    return streamThreadRoom({
      threadId: thread.id,
      workspaceId: workspace.id,
      viewerUserId: input.userId,
      signal: input.signal,
      // Re-run the FULL open gate each beat so a viewer who loses access
      // mid-stream (removed from the workspace, or the thread flipped to
      // private) is evicted within one beat — not just a thread-visibility
      // recheck, which would miss a workspace-membership removal.
      checkAccess: async () => {
        const currentWorkspace = await workspaceService.resolveWorkspace({
          workspaceId: input.workspaceId,
          userId: input.userId,
        });
        if (!currentWorkspace) {
          return false;
        }
        const currentThread = await findThreadRecord({
          threadId: input.threadId,
          teamId: currentWorkspace.organizationId,
          workspaceId: currentWorkspace.id,
        });
        return Boolean(
          currentThread && canViewThread(input.userId, currentThread),
        );
      },
    });
  }

  /**
   * Broadcast that a viewer is typing. Same `canViewThread` gate as the room,
   * server-side rate limited, fire-and-forget. `threadId`/`userId` come from the
   * route + session, never the body, so typing can't be forged as another user.
   */
  async emitTyping(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    typing: boolean;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread || !canViewThread(input.userId, thread)) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    if (!typingRateLimiter.allow(input.userId, thread.id)) {
      return;
    }

    void publishThreadEvent({
      threadId: thread.id,
      workspaceId: workspace.id,
      kind: "typing",
      actorUserId: input.userId,
      typing: input.typing,
    }).catch(() => undefined);
  }

  /**
   * Resolve display identities for viewers currently present on a thread. Gated
   * by `canViewThread`, and the requested ids are intersected with the LIVE
   * presence roster so this can't be used to scrape arbitrary users. Covers
   * guests (cross-org users not in the member table) — flagged `isGuest`.
   */
  async resolveThreadPresenceIdentities(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    userIds: string[];
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread || !canViewThread(input.userId, thread)) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    const present = new Set(await readPresence(thread.id));
    const wanted = [...new Set(input.userIds)].filter((id) => present.has(id));
    if (wanted.length === 0) {
      return { identities: [] };
    }

    const [records, memberIds] = await Promise.all([
      findUserIdentitiesByIds(wanted),
      filterOrganizationMemberIds({
        organizationId: workspace.organizationId,
        userIds: wanted,
      }),
    ]);

    return {
      identities: records.map((record) => ({
        userId: record.userId,
        name: record.name,
        email: record.email,
        image: record.image,
        isGuest: !memberIds.has(record.userId),
      })),
    };
  }

  async getMessageImageFile(input: {
    workspaceId: string;
    messageId: string;
    imageId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const message = await findMessageRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      messageId: input.messageId,
    });
    if (!message) {
      throw new ContentError(404, "MESSAGE_NOT_FOUND", "Message not found");
    }

    const image = findImagePart({
      contentJson: message.contentJson,
      imageId: input.imageId,
    });
    if (!image) {
      throw new ContentError(
        404,
        "CHAT_IMAGE_NOT_FOUND",
        "Message image not found",
      );
    }

    return {
      body: await downloadChatImageObject({
        bucket: image.storageBucket,
        key: image.storageKey,
      }),
      contentType: image.mimeType,
      fileName: image.fileName,
    };
  }
}

export const contentThreadService = new ContentThreadService();
