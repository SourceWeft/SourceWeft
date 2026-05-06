import { findCitationByMessageRank } from "../citations";
import { ContentError } from "../errors";
import {
  normalizeContentTitle,
  requireContentWorkspace,
} from "../content-support";
import {
  getMetadataNumber,
  getMetadataString,
  toObjectRecord,
} from "../metadata";
import {
  createThreadRecord,
  deleteThreadRecord,
  findThreadRecord,
  listThreadRecordsByWorkspace,
  updateThreadModelSettingsRecord,
} from "./thread/repository";
import { listMessageRecordsByThread } from "./message-repository";
import {
  mergeThreadModelSettings,
  normalizeThreadModelSettings,
  pruneUnavailableThreadModelAliases,
  resolveThreadModelSettingsSnapshots,
  validateThreadModelSettings,
} from "./model-settings";
import { decodeThreadsCursor, encodeThreadsCursor } from "./thread/cursor";
import { listThreadModelCatalog } from "./thread/model-catalog";

const DEFAULT_THREAD_PAGE_LIMIT = 20;

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

    if (!thread) {
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

    const deleted = await deleteThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
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

    if (!thread) {
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
    const sanitizedCurrentSettings = await pruneUnavailableThreadModelAliases(
      currentSettings,
      patch,
    );

    const nextSettings = mergeThreadModelSettings(
      sanitizedCurrentSettings,
      patch,
    );

    await validateThreadModelSettings(nextSettings);
    const resolvedNextSettings = await resolveThreadModelSettingsSnapshots(nextSettings);

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
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const modelSettings = normalizeThreadModelSettings(input.modelSettings);
    await validateThreadModelSettings(modelSettings);
    const resolvedModelSettings = await resolveThreadModelSettingsSnapshots(modelSettings);

    const thread = await createThreadRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeContentTitle(input.title, "New Thread"),
      createdBy: input.userId,
      modelSettings: resolvedModelSettings,
    });

    return { thread };
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

    return {
      citation: {
        citation: citation.citationKey,
        score: citation.score,
        sourceId: citation.sourceId,
        sourceTitle: citation.sourceTitle ?? sourceTitleSnapshot,
        documentId: citation.documentId,
        chunkId: citation.chunkId ?? citation.externalUri ?? `external:${citation.citationKey}`,
        chunkNo: chunkNoSnapshot,
        externalUri: citation.externalUri,
        excerpt: citation.quoteText ?? citation.chunkContent ?? excerptSnapshot ?? "",
      },
    };
  }

  async listThreadMessages(input: {
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

    if (!thread) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    const items = await listMessageRecordsByThread({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
    });

    return { items };
  }
}

export const contentThreadService = new ContentThreadService();
