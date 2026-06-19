import assert from "node:assert/strict";
import { test } from "vitest";
import {
  NO_VISIBLE_READ_FILE_CONTENT,
  READ_FILE_PREVIEW_LINE_LIMIT,
  getReadFilePreview,
  resolveReadFilePath,
} from "./read-file-preview";
import type { ToolCallRecord } from "./types";

function readFileToolCall(input: {
  content?: string;
  displayContent?: string;
  input?: Record<string, unknown>;
}): ToolCallRecord {
  const output =
    input.displayContent !== undefined
      ? { displayContent: input.displayContent }
      : { content: input.content ?? "" };

  return {
    error: null,
    id: "call-read-file",
    input: input.input ?? {},
    latencyMs: 12,
    output,
    status: "completed",
    tool: "read_file",
  };
}

test("resolves read_file path from supported input fields", () => {
  assert.equal(
    resolveReadFilePath({ path: "/workfiles/a.md" }),
    "/workfiles/a.md",
  );
  assert.equal(
    resolveReadFilePath({ file_path: "/kb/source.md" }),
    "/kb/source.md",
  );
  assert.equal(
    resolveReadFilePath({ filePath: "/workspace/app.ts" }),
    "/workspace/app.ts",
  );
});

test("builds ordinary read_file preview with file name and first six lines", () => {
  const preview = getReadFilePreview(
    readFileToolCall({
      content: [
        "line one",
        "line two",
        "line three",
        "line four",
        "line five",
        "line six",
        "line seven",
      ].join("\n"),
      input: { file_path: "/workfiles/notes/report.md" },
    }),
  );

  assert.deepEqual(preview?.lines, [
    "line one",
    "line two",
    "line three",
    "line four",
    "line five",
    "line six",
  ]);
  assert.equal(preview?.fileName, "report.md");
  assert.equal(preview?.path, "/workfiles/notes/report.md");
  assert.equal(preview?.lineLimit, READ_FILE_PREVIEW_LINE_LIMIT);
  assert.equal(preview?.isTruncated, true);
});

test("uses displayContent from normalized read_file output", () => {
  const preview = getReadFilePreview(
    readFileToolCall({
      displayContent: "preview from display content",
      input: { path: "/kb/invoice.md" },
    }),
  );

  assert.deepEqual(preview?.lines, ["preview from display content"]);
  assert.equal(preview?.isTruncated, false);
});

test("shows the file path even when read_file returns empty visible content", () => {
  const preview = getReadFilePreview(
    readFileToolCall({
      content: "",
      input: { path: "/workfiles/empty.md" },
    }),
  );

  assert.deepEqual(preview?.lines, [NO_VISIBLE_READ_FILE_CONTENT]);
  assert.equal(preview?.fileName, "empty.md");
  assert.equal(preview?.isTruncated, false);
});

test("does not build previews for private skill instruction reads", () => {
  assert.equal(
    getReadFilePreview(
      readFileToolCall({
        content: "must never render",
        input: { file_path: "/skills/feynman/SKILL.md" },
      }),
    ),
    null,
  );
  assert.equal(
    getReadFilePreview(
      readFileToolCall({
        content: "must never render",
        input: {
          filesystemScope: "skills",
          visibility: "internal_instruction",
        },
      }),
    ),
    null,
  );
});
