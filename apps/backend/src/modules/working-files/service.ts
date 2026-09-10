import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  uploadFileObject,
  downloadFileObject,
  deleteArtifactObject,
} from "../sources/storage";
import { logger } from "../../shared/logger";
import { canViewThread } from "../workspace/content-visibility";
import { ContentError } from "../content/errors";
import { requireContentWorkspace } from "../workspace/guards";
import { findThreadRecord } from "../threads/thread/repository";
import type { WorkingFilePurpose } from "../content/types";
import {
  countWorkingFileRecords,
  deleteWorkingFileRecord,
  findWorkingFileRecord,
  listWorkingFileRecords,
  listWorkingFileRecordsByUpdatedAt,
  touchWorkingFileRecord,
  upsertWorkingFileRecord,
} from "./repository";
import { normalizeWorkingFilePath } from "./paths";
import type { WorkingFileRecord } from "../content/types";

export const MAX_WORKING_FILE_BYTES = 256 * 1024;
export const MAX_WORKING_FILES_PER_THREAD = 200;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

function contentSizeBytes(contentText: string) {
  return Buffer.byteLength(contentText, "utf8");
}

function normalizeMimeType(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "text/plain";
  }
  return trimmed.slice(0, 128);
}

function assertWorkingFileSize(contentText: string) {
  const sizeBytes = contentSizeBytes(contentText);
  if (sizeBytes > MAX_WORKING_FILE_BYTES) {
    throw new ContentError(
      413,
      "WORKING_FILE_TOO_LARGE",
      `Working file exceeds ${MAX_WORKING_FILE_BYTES} bytes`,
    );
  }
  return sizeBytes;
}

function assertTextOnly(mimeType: string) {
  if (
    !mimeType.startsWith("text/") &&
    mimeType !== "application/json" &&
    mimeType !== "application/xml" &&
    mimeType !== "application/x-yaml" &&
    mimeType !== "application/yaml" &&
    mimeType !== "application/toml"
  ) {
    throw new ContentError(
      400,
      "UNSUPPORTED_WORKING_FILE_TYPE",
      "Working files only support text content",
    );
  }
}

export function toWorkingFileListItem(file: WorkingFileRecord) {
  const {
    contentText: _contentText,
    storageBucket: _bucket,
    storageKey: _key,
    ...item
  } = file;
  return item;
}

export class WorkingFilesService {
  async requireThreadScope(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const thread = await findThreadRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
    });

    if (!thread || !canViewThread(input.userId, thread)) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    if (thread.executionTarget?.kind === "local") {
      throw new ContentError(
        409,
        "LOCAL_FILES_USE_DIRECTORY",
        "This conversation uses Files on its selected computer.",
      );
    }
    return { workspace, thread };
  }

  async listWorkingFiles(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const { workspace, thread } = await this.requireThreadScope(input);
    const items = await listWorkingFileRecordsByUpdatedAt({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
    });
    return { items: items.map(toWorkingFileListItem) };
  }

  async listForBackend(input: {
    teamId: string;
    workspaceId: string;
    threadId: string;
  }) {
    return listWorkingFileRecords(input);
  }

  async getWorkingFile(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
  }) {
    const { workspace, thread } = await this.requireThreadScope(input);
    const path = normalizeWorkingFilePath(input.path);
    const file = await findWorkingFileRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      path,
    });

    if (!file) {
      throw new ContentError(
        404,
        "WORKING_FILE_NOT_FOUND",
        "Working file not found",
      );
    }

    return { file };
  }

  async putWorkingFile(input: {
    signal?: AbortSignal;
    expectedRevision?: string;
    origin?: WorkingFileRecord["origin"];
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
    contentText: string;
    mimeType?: string | null;
    purpose?: WorkingFilePurpose | null;
  }) {
    const { workspace, thread } = await this.requireThreadScope(input);
    const path = normalizeWorkingFilePath(input.path);
    const mimeType = normalizeMimeType(input.mimeType);
    assertTextOnly(mimeType);
    const sizeBytes = assertWorkingFileSize(input.contentText);
    const existing = await findWorkingFileRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      path,
    });
    if (!existing) {
      const count = await countWorkingFileRecords({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        threadId: thread.id,
      });
      if (count >= MAX_WORKING_FILES_PER_THREAD) {
        throw new ContentError(
          409,
          "WORKING_FILE_LIMIT_EXCEEDED",
          `Thread has reached the ${MAX_WORKING_FILES_PER_THREAD} working file limit`,
        );
      }
    }

    const file = await upsertWorkingFileRecord({
      signal: input.signal,
      expectedRevision: input.expectedRevision,
      origin: existing?.origin ?? input.origin ?? "user_provided",
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      path,
      contentText: input.contentText,
      mimeType,
      sizeBytes,
      purpose: input.purpose,
      createdBy: input.userId,
    });

    return { file };
  }

  async readBytes(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
    signal?: AbortSignal;
  }) {
    const { file } = await this.getWorkingFile(input);
    const bytes =
      file.payloadKind === "object"
        ? await downloadFileObject({
            bucket: file.storageBucket!,
            key: file.storageKey!,
            maxBytes: MAX_FILE_BYTES,
            signal: input.signal,
          })
        : Buffer.from(file.contentText, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== file.contentHash || bytes.length !== file.sizeBytes)
      throw new ContentError(
        409,
        "FILE_CHANGED",
        "Stored file content does not match its revision.",
      );
    return { file, bytes };
  }

  async putBytes(input: {
    signal?: AbortSignal;
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
    bytes: Buffer;
    mimeType: string;
    expectedRevision?: string;
    origin?: WorkingFileRecord["origin"];
  }) {
    const { workspace, thread } = await this.requireThreadScope(input);
    if (input.bytes.length > MAX_FILE_BYTES)
      throw new ContentError(
        413,
        "FILE_TOO_LARGE",
        "Files are limited to 20 MiB.",
      );
    const path = normalizeWorkingFilePath(input.path);
    const scope = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
    };
    const existing = await findWorkingFileRecord({ ...scope, path });
    if (
      !existing &&
      (await countWorkingFileRecords(scope)) >= MAX_WORKING_FILES_PER_THREAD
    )
      throw new ContentError(
        409,
        "WORKING_FILE_LIMIT_EXCEEDED",
        "This conversation has reached its file limit.",
      );
    if (existing && input.expectedRevision !== `sha256:${existing.contentHash}`)
      throw new ContentError(
        409,
        "FILE_CHANGED",
        "Read the current file before replacing it.",
      );
    input.signal?.throwIfAborted();
    const object = await uploadFileObject({
      signal: input.signal,
      key: `workspaces/${encodeURIComponent(workspace.id)}/threads/${encodeURIComponent(thread.id)}/files/${randomUUID()}`,
      body: input.bytes,
      contentType: normalizeMimeType(input.mimeType),
    });
    let file: WorkingFileRecord;
    try {
      input.signal?.throwIfAborted();
      file = await upsertWorkingFileRecord({
        ...scope,
        path,
        contentText: "",
        mimeType: normalizeMimeType(input.mimeType),
        sizeBytes: input.bytes.length,
        object: {
          ...object,
          contentHash: createHash("sha256").update(input.bytes).digest("hex"),
        },
        signal: input.signal,
      expectedRevision: input.expectedRevision,
        createdBy: input.userId,
        origin: existing?.origin ?? input.origin ?? "user_provided",
      });
    } catch (error) {
      try {
        await deleteArtifactObject(object);
      } catch (cleanup) {
        logger.warn("Uncommitted file object cleanup failed", {
          error: String(cleanup),
        });
      }
      throw error;
    }
    if (existing?.storageKey && existing.storageBucket) {
      try {
        await deleteArtifactObject({
          bucket: existing.storageBucket,
          key: existing.storageKey,
        });
      } catch (error) {
        logger.warn("Replaced file object cleanup failed", {
          fileId: file.id,
          error: String(error),
        });
      }
    }
    return { file };
  }

  async touchWorkingFile(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
    mimeType?: string | null;
    purpose?: WorkingFilePurpose | null;
  }) {
    const { workspace, thread } = await this.requireThreadScope(input);
    const path = normalizeWorkingFilePath(input.path);
    const mimeType = normalizeMimeType(input.mimeType);
    assertTextOnly(mimeType);
    const existing = await findWorkingFileRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      path,
    });
    if (!existing) {
      const count = await countWorkingFileRecords({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        threadId: thread.id,
      });
      if (count >= MAX_WORKING_FILES_PER_THREAD) {
        throw new ContentError(
          409,
          "WORKING_FILE_LIMIT_EXCEEDED",
          `Thread has reached the ${MAX_WORKING_FILES_PER_THREAD} working file limit`,
        );
      }
    }
    const file = await touchWorkingFileRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      path,
      mimeType,
      purpose: input.purpose,
      createdBy: input.userId,
    });
    return { file };
  }

  async deleteWorkingFile(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    path: string;
  }) {
    const { workspace, thread } = await this.requireThreadScope(input);
    const path = normalizeWorkingFilePath(input.path);
    const deletedPath = await deleteWorkingFileRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      path,
    });

    if (!deletedPath) {
      throw new ContentError(
        404,
        "WORKING_FILE_NOT_FOUND",
        "Working file not found",
      );
    }

    return { deleted: true as const, path: deletedPath };
  }
}

export const workingFilesService = new WorkingFilesService();
