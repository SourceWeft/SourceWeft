import type { ToolCallRecord } from "./types";
import {
  basename,
  resolveWorkfileCodeLanguage,
  type WorkfileCodeLanguage,
} from "../workfile-content-preview";

export const WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT = 8_000;

export type WorkfileMutationPreviewModel =
  | {
      kind: "write";
      language: WorkfileCodeLanguage;
      lineCount: number;
      path: string;
      previewContent: string;
      previewTruncated: boolean;
      sizeBytes: number;
    }
  | {
      diffPreview: string | null;
      kind: "edit";
      occurrences: number | null;
      path: string;
      previewTruncated: boolean;
      replaceAll: boolean | null;
    };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getStringField(
  record: Record<string, unknown> | undefined,
  keys: string[],
  options: { allowEmpty?: boolean; trim?: boolean } = {},
) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value !== "string") {
      continue;
    }
    const normalized = options.trim ? value.trim() : value;
    if (options.allowEmpty || normalized.trim().length > 0) {
      return normalized;
    }
  }
  return null;
}

function getBooleanField(
  record: Record<string, unknown> | undefined,
  keys: string[],
) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function getNumberField(
  record: Record<string, unknown> | undefined,
  keys: string[],
) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

export function isWorkfilePath(
  value: string | null | undefined,
): value is string {
  return Boolean(value?.startsWith("/workfiles/"));
}

/** Code authored directly into the provider sandbox (`/workspace`). */
export function isSandboxCodePath(
  value: string | null | undefined,
): value is string {
  return Boolean(value?.startsWith("/workspace/"));
}

/** Any path we render as a syntax-highlighted code preview. */
export function isCodeFilePath(
  value: string | null | undefined,
): value is string {
  return isWorkfilePath(value) || isSandboxCodePath(value);
}

function resolveToolPath(toolCall: ToolCallRecord) {
  const output = isObjectRecord(toolCall.output) ? toolCall.output : undefined;
  return (
    getStringField(toolCall.input, ["path", "file_path", "filePath"], {
      trim: true,
    }) ??
    getStringField(output, ["path", "file_path", "filePath"], {
      trim: true,
    })
  );
}

function textSizeBytes(value: string) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

function lineCount(value: string) {
  if (value.length === 0) {
    return 0;
  }
  return value.split(/\r\n|\r|\n/).length;
}

function previewText(value: string) {
  if (value.length <= WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT) {
    return {
      content: value,
      truncated: false,
    };
  }
  return {
    content: value.slice(0, WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT).trimEnd(),
    truncated: true,
  };
}

function buildDiffPreview(input: {
  newString: string | null;
  oldString: string | null;
  path: string;
}) {
  if (input.oldString === null || input.newString === null) {
    return {
      content: null,
      truncated: false,
    };
  }

  const diff = [
    `--- ${basename(input.path)}`,
    `+++ ${basename(input.path)}`,
    ...input.oldString.split(/\r\n|\r|\n/).map((line) => `-${line}`),
    ...input.newString.split(/\r\n|\r|\n/).map((line) => `+${line}`),
  ].join("\n");
  const preview = previewText(diff);
  return {
    content: preview.content,
    truncated: preview.truncated,
  };
}

export function resolveWorkfileMutationPreview(
  toolCall: ToolCallRecord,
): WorkfileMutationPreviewModel | null {
  const path = resolveToolPath(toolCall);
  if (!isCodeFilePath(path)) {
    return null;
  }

  if (toolCall.tool === "write_file") {
    const content = getStringField(toolCall.input, ["content"], {
      allowEmpty: true,
    });
    if (content === null) {
      return null;
    }
    const preview = previewText(content);
    return {
      kind: "write",
      language: resolveWorkfileCodeLanguage({ path }),
      lineCount: lineCount(content),
      path,
      previewContent: preview.content,
      previewTruncated: preview.truncated,
      sizeBytes: textSizeBytes(content),
    };
  }

  if (toolCall.tool === "edit_file") {
    const output = isObjectRecord(toolCall.output)
      ? toolCall.output
      : undefined;
    const oldString = getStringField(
      toolCall.input,
      ["oldString", "old_string", "old_str"],
      {
        allowEmpty: true,
      },
    );
    const newString = getStringField(
      toolCall.input,
      ["newString", "new_string", "new_str"],
      {
        allowEmpty: true,
      },
    );
    const diff = buildDiffPreview({ newString, oldString, path });
    return {
      diffPreview: diff.content,
      kind: "edit",
      occurrences: getNumberField(output, ["occurrences"]),
      path,
      previewTruncated: diff.truncated,
      replaceAll: getBooleanField(toolCall.input, [
        "replaceAll",
        "replace_all",
      ]),
    };
  }

  return null;
}

export function getWorkfileMutationToolTitle(toolCall: ToolCallRecord) {
  const path = resolveToolPath(toolCall);
  if (!isCodeFilePath(path)) {
    return null;
  }
  const location = isWorkfilePath(path) ? "Workfile" : "sandbox file";
  if (toolCall.tool === "write_file") {
    return `Wrote ${location}: ${basename(path)}`;
  }
  if (toolCall.tool === "edit_file") {
    return `Edited ${location}: ${basename(path)}`;
  }
  return null;
}
