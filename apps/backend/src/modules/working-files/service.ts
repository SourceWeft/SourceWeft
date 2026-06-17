import { Buffer } from "node:buffer";
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
  const { contentText: _contentText, ...item } = file;
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

    if (!thread) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
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
      throw new ContentError(404, "WORKING_FILE_NOT_FOUND", "Working file not found");
    }

    return { file };
  }

  async putWorkingFile(input: {
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
      throw new ContentError(404, "WORKING_FILE_NOT_FOUND", "Working file not found");
    }

    return { deleted: true as const, path: deletedPath };
  }
}

export const workingFilesService = new WorkingFilesService();
