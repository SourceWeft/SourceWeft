import { getToolOutputContent } from "./message-assets";
import type { ToolCallRecord } from "./types";

export const READ_FILE_PREVIEW_LINE_LIMIT = 6;
export const NO_VISIBLE_READ_FILE_CONTENT = "(no visible content)";
export const READ_FILE_BINARY_UNSUPPORTED_CODE =
  "READ_FILE_BINARY_UNSUPPORTED";

export type ReadFilePreview = {
  fileName: string | null;
  isTruncated: boolean;
  lineLimit: number;
  lines: string[];
  path: string | null;
};

export type ReadFileBinaryUnsupported = {
  code: typeof READ_FILE_BINARY_UNSUPPORTED_CODE;
  message: string;
  path: string | null;
};

function getStringInputValue(
  input: Record<string, unknown> | undefined,
  key: string,
) {
  const value = input?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function resolveReadFilePath(
  input: Record<string, unknown> | undefined,
) {
  return (
    getStringInputValue(input, "path") ??
    getStringInputValue(input, "file_path") ??
    getStringInputValue(input, "filePath")
  );
}

function isSkillInstructionPath(path: string | null) {
  return path === "/skills" || Boolean(path?.startsWith("/skills/"));
}

function isSkillInstructionRead(input: Record<string, unknown> | undefined) {
  return (
    input?.filesystemScope === "skills" ||
    input?.visibility === "internal_instruction" ||
    isSkillInstructionPath(resolveReadFilePath(input))
  );
}

function getStringRecordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

function readFileBinaryUnsupportedMessage(toolCall: ToolCallRecord) {
  const candidates = [
    toolCall.error,
    getStringRecordValue(toolCall.output, "error"),
    getStringRecordValue(toolCall.output, "message"),
    getToolOutputContent(toolCall.output),
  ];
  return (
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        candidate.trim().startsWith(`${READ_FILE_BINARY_UNSUPPORTED_CODE}:`),
    ) ?? null
  );
}

export function getReadFileBinaryUnsupported(
  toolCall: ToolCallRecord,
): ReadFileBinaryUnsupported | null {
  if (toolCall.tool !== "read_file") {
    return null;
  }
  const message = readFileBinaryUnsupportedMessage(toolCall);
  if (!message) {
    return null;
  }
  return {
    code: READ_FILE_BINARY_UNSUPPORTED_CODE,
    message,
    path: resolveReadFilePath(toolCall.input),
  };
}

function basename(path: string | null) {
  if (!path) {
    return null;
  }
  const normalized = path.replace(/\/+$/g, "");
  return normalized.split("/").at(-1)?.trim() || normalized || null;
}

function splitPreviewLines(content: string, lineLimit: number) {
  if (content.trim().length === 0) {
    return {
      isTruncated: false,
      lines: [NO_VISIBLE_READ_FILE_CONTENT],
    };
  }

  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return {
    isTruncated: lines.length > lineLimit,
    lines: lines.slice(0, lineLimit),
  };
}

export function getReadFilePreview(
  toolCall: ToolCallRecord,
  lineLimit = READ_FILE_PREVIEW_LINE_LIMIT,
): ReadFilePreview | null {
  if (toolCall.tool !== "read_file") {
    return null;
  }

  const path = resolveReadFilePath(toolCall.input);
  if (isSkillInstructionRead(toolCall.input)) {
    return null;
  }
  if (getReadFileBinaryUnsupported(toolCall)) {
    return null;
  }

  const content = getToolOutputContent(toolCall.output);
  if (content === null || content === undefined || content === "{}") {
    return null;
  }

  const boundedLineLimit = Math.max(1, Math.floor(lineLimit));
  const preview = splitPreviewLines(content, boundedLineLimit);
  return {
    fileName: basename(path),
    isTruncated: preview.isTruncated,
    lineLimit: boundedLineLimit,
    lines: preview.lines,
    path,
  };
}
