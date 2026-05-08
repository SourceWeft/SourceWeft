import type {
  BackendProtocolV2,
  EditResult,
  FileData,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";
import type { WorkingFileRecord, WorkingFilePurpose } from "../types";
import {
  WORK_ROOT,
  basename,
  normalizeWorkingFilePath,
  normalizeWorkingFsPath,
} from "../working-files";
import { workingFilesService } from "../working-files";
import {
  MAX_GLOB_RESULTS,
  MAX_GREP_RESULTS,
  compileGrepRegex,
  lineNumberContent,
  performStringReplacement,
  simpleGlobToRegExp,
} from "./fs-utils";

const DEFAULT_READ_LINE_LIMIT = 500;
const DEFAULT_WORKING_FILE_MIME_TYPE = "text/plain";

function fileInfo(file: WorkingFileRecord): FileInfo {
  return {
    path: file.path,
    is_dir: false,
    size: file.sizeBytes,
    modified_at: file.updatedAt,
  };
}

function directoryInfo(path: string, modifiedAt?: string): FileInfo {
  return {
    path: path.endsWith("/") ? path : `${path}/`,
    is_dir: true,
    size: 0,
    modified_at: modifiedAt,
  };
}

function directChildPath(input: { base: string; candidate: string }) {
  if (input.base === WORK_ROOT) {
    const rest = input.candidate.slice(`${WORK_ROOT}/`.length);
    if (!rest) {
      return null;
    }
    const slashIndex = rest.indexOf("/");
    return slashIndex === -1
      ? `${WORK_ROOT}/${rest}`
      : `${WORK_ROOT}/${rest.slice(0, slashIndex)}`;
  }

  if (!input.candidate.startsWith(`${input.base}/`)) {
    return null;
  }
  const rest = input.candidate.slice(input.base.length + 1);
  if (!rest) {
    return null;
  }
  const slashIndex = rest.indexOf("/");
  return slashIndex === -1
    ? `${input.base}/${rest}`
    : `${input.base}/${rest.slice(0, slashIndex)}`;
}

function candidatePaths(files: WorkingFileRecord[]) {
  const paths = new Map<string, FileInfo>();
  for (const file of files) {
    paths.set(file.path, fileInfo(file));
    const parts = file.path.slice(`${WORK_ROOT}/`.length).split("/");
    let current = WORK_ROOT;
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = `${current}/${parts[index]}`;
      paths.set(current, directoryInfo(current, file.updatedAt));
    }
  }
  return Array.from(paths.values());
}

function inferMimeType(path: string) {
  if (path.endsWith(".md") || path.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (path.endsWith(".json")) {
    return "application/json";
  }
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return "application/yaml";
  }
  if (path.endsWith(".xml")) {
    return "application/xml";
  }
  if (path.endsWith(".toml")) {
    return "application/toml";
  }
  return DEFAULT_WORKING_FILE_MIME_TYPE;
}

function toError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class WorkingFilesBackend implements BackendProtocolV2 {
  constructor(
    private readonly input: {
      teamId: string;
      workspaceId: string;
      threadId: string;
      userId: string;
    },
  ) {}

  private async files() {
    return workingFilesService.listForBackend({
      teamId: this.input.teamId,
      workspaceId: this.input.workspaceId,
      threadId: this.input.threadId,
    });
  }

  private async getFile(path: string) {
    const normalized = normalizeWorkingFilePath(path);
    const result = await workingFilesService.getWorkingFile({
      workspaceId: this.input.workspaceId,
      threadId: this.input.threadId,
      userId: this.input.userId,
      path: normalized,
    }).catch((error) => ({ error }));

    if ("error" in result) {
      return null;
    }
    return result.file;
  }

  async ls(path = WORK_ROOT): Promise<LsResult> {
    try {
      const normalized = normalizeWorkingFsPath(path || WORK_ROOT);
      if (normalized === "/") {
        return { files: [directoryInfo(WORK_ROOT)] };
      }
      const files = await this.files();
      if (normalized !== WORK_ROOT) {
        const directFile = files.find((file) => file.path === normalized);
        if (directFile) {
          return { error: `ENOTDIR: not a directory, ls '${normalized}'` };
        }
      }

      const children = new Map<string, FileInfo>();
      for (const file of files) {
        const childPath = directChildPath({ base: normalized, candidate: file.path });
        if (!childPath) {
          continue;
        }
        if (childPath === file.path) {
          children.set(childPath, fileInfo(file));
        } else {
          children.set(childPath, directoryInfo(childPath, file.updatedAt));
        }
      }

      return {
        files: Array.from(children.values()).sort((a, b) => a.path.localeCompare(b.path)),
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async glob(pattern: string, path = WORK_ROOT): Promise<GlobResult> {
    try {
      const base = normalizeWorkingFsPath(path);
      const normalizedPattern = pattern.startsWith("/")
        ? pattern.replace(/\/+$/g, "") || "/"
        : `${base}/${pattern}`.replace(/\/+/g, "/");
      const matcher = simpleGlobToRegExp(normalizedPattern);
      const files = await this.files();
      return {
        files: candidatePaths(files)
          .filter((candidate) => matcher.test(candidate.path.replace(/\/$/, "")))
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, MAX_GLOB_RESULTS),
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async read(filePath: string, offset = 0, limit = DEFAULT_READ_LINE_LIMIT): Promise<ReadResult> {
    try {
      const normalized = normalizeWorkingFilePath(filePath);
      const file = await this.getFile(normalized);
      if (!file) {
        return { error: `ENOENT: no such file, read_file '${normalized}'` };
      }

      const lines = lineNumberContent(file.contentText).split("\n");
      const boundedOffset = Math.max(0, offset);
      const boundedLimit = Math.max(1, Math.min(limit, DEFAULT_READ_LINE_LIMIT));
      if (boundedOffset >= lines.length && lines.length > 0) {
        return { error: `Line offset ${offset} exceeds file length (${lines.length} lines)` };
      }
      const selected = lines.slice(boundedOffset, boundedOffset + boundedLimit);
      const more = boundedOffset + selected.length < lines.length
        ? `\n\nOutput truncated. Continue with read_file(path: "${normalized}", offset: ${boundedOffset + selected.length}, limit: ${boundedLimit}).`
        : "";

      return {
        mimeType: file.mimeType,
        content: [
          `Path: ${file.path}`,
          `Working file: ${basename(file.path)}`,
          `MIME: ${file.mimeType}`,
          file.purpose ? `Purpose: ${file.purpose}` : null,
          "Working files are database-persisted thread working memory, not source evidence. Use them to continue or supplement thread work, but do not cite this file as a source.",
          "",
          selected.join("\n"),
          more,
        ].filter((line): line is string => line !== null).join("\n"),
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      const normalized = normalizeWorkingFilePath(filePath);
      const file = await this.getFile(normalized);
      if (!file) {
        return { error: `ENOENT: no such file, read_file '${normalized}'` };
      }
      const data: FileData = {
        content: file.contentText,
        mimeType: file.mimeType,
        created_at: file.createdAt,
        modified_at: file.updatedAt,
      };
      return { data };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async grep(pattern: string, path: string | null = WORK_ROOT, glob?: string | null): Promise<GrepResult> {
    try {
      const normalized = normalizeWorkingFsPath(path || WORK_ROOT);
      const regex = compileGrepRegex(pattern);
      if (typeof regex === "string") {
        return { error: regex };
      }
      const files = await this.files();
      const matcher = glob
        ? simpleGlobToRegExp(
            glob.startsWith("/")
              ? glob.replace(/\/+$/g, "") || "/"
              : `${normalized}/${glob}`.replace(/\/+/g, "/"),
          )
        : null;
      const targetFiles = files.filter((file) =>
        file.path === normalized ||
        normalized === WORK_ROOT ||
        file.path.startsWith(`${normalized}/`)
      );
      const matches: GrepMatch[] = [];
      for (const file of targetFiles) {
        if (matcher && !matcher.test(file.path)) {
          continue;
        }
        const lines = file.contentText.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (matches.length >= MAX_GREP_RESULTS) {
            return { matches };
          }
          if (regex.test(line)) {
            matches.push({
              path: file.path,
              line: index + 1,
              text: line.trim(),
            });
          }
        }
      }
      return { matches };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const normalized = normalizeWorkingFilePath(filePath);
      const result = await workingFilesService.putWorkingFile({
        workspaceId: this.input.workspaceId,
        threadId: this.input.threadId,
        userId: this.input.userId,
        path: normalized,
        contentText: content,
        mimeType: inferMimeType(normalized),
      });
      return {
        path: result.file.path,
        filesUpdate: null,
        metadata: { sizeBytes: result.file.sizeBytes },
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<EditResult> {
    try {
      const normalized = normalizeWorkingFilePath(filePath);
      const file = await this.getFile(normalized);
      if (!file) {
        return { error: `Error: File '${normalized}' not found` };
      }
      const replacement = performStringReplacement(
        file.contentText,
        oldString,
        newString,
        replaceAll,
      );
      if (typeof replacement === "string") {
        return { error: replacement };
      }
      const [contentText, occurrences] = replacement;
      const result = await workingFilesService.putWorkingFile({
        workspaceId: this.input.workspaceId,
        threadId: this.input.threadId,
        userId: this.input.userId,
        path: normalized,
        contentText,
        mimeType: file.mimeType,
        purpose: file.purpose as WorkingFilePurpose | null,
      });
      return {
        path: result.file.path,
        filesUpdate: null,
        occurrences,
        metadata: { sizeBytes: result.file.sizeBytes },
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }
}
