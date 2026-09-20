import assert from "node:assert/strict";
import { test } from "vitest";
import { createTranslator } from "next-intl";
import type { useTranslations } from "next-intl";
import type { ToolCallRecord } from "./types";
import {
  WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT,
  getWorkfileMutationToolTitle,
  resolveWorkfileMutationPreview,
} from "./workfile-mutation-state";
import messages from "../../../../../messages/en.json";

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "dashboardChatCanvas",
}) as unknown as ReturnType<typeof useTranslations>;

function toolCall(input: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    error: null,
    id: "call-1",
    input: {},
    latencyMs: 10,
    output: null,
    status: "completed",
    tool: "write_file",
    ...input,
  };
}

test("resolveWorkfileMutationPreview builds write_file code preview", () => {
  const preview = resolveWorkfileMutationPreview(
    toolCall({
      input: {
        content: "console.log('deck');\n",
        path: "/files/ppt/deck.js",
      },
      tool: "write_file",
    }),
  );

  assert.equal(preview?.kind, "write");
  assert.equal(preview?.path, "/files/ppt/deck.js");
  assert.equal(
    preview?.kind === "write" ? preview.language : null,
    "javascript",
  );
  assert.equal(preview?.kind === "write" ? preview.lineCount : null, 2);
  assert.equal(
    preview?.kind === "write" ? preview.previewContent : null,
    "console.log('deck');\n",
  );
  assert.equal(preview?.previewTruncated, false);
});

test("resolveWorkfileMutationPreview truncates long write_file content", () => {
  const content = "a".repeat(WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT + 50);
  const preview = resolveWorkfileMutationPreview(
    toolCall({
      input: {
        content,
        path: "/files/ppt/deck.ts",
      },
      tool: "write_file",
    }),
  );

  assert.equal(preview?.kind, "write");
  assert.equal(preview?.previewTruncated, true);
  assert.equal(
    preview?.kind === "write" ? preview.previewContent.length : null,
    WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT,
  );
  assert.equal(
    preview?.kind === "write" ? preview.language : null,
    "typescript",
  );
});

test("resolveWorkfileMutationPreview handles empty write_file content", () => {
  const preview = resolveWorkfileMutationPreview(
    toolCall({
      input: {
        content: "",
        path: "/files/ppt/empty.txt",
      },
      tool: "write_file",
    }),
  );

  assert.equal(preview?.kind, "write");
  assert.equal(preview?.kind === "write" ? preview.language : null, "log");
  assert.equal(preview?.kind === "write" ? preview.lineCount : null, 0);
  assert.equal(preview?.kind === "write" ? preview.previewContent : null, "");
  assert.equal(preview?.kind === "write" ? preview.sizeBytes : null, 0);
});

test("resolveWorkfileMutationPreview keeps markdown write_file language", () => {
  const preview = resolveWorkfileMutationPreview(
    toolCall({
      input: {
        content: "# Deck",
        path: "/files/ppt/README.md",
      },
      tool: "write_file",
    }),
  );

  assert.equal(preview?.kind, "write");
  assert.equal(preview?.kind === "write" ? preview.language : null, "markdown");
});

test("resolveWorkfileMutationPreview builds edit_file diff preview", () => {
  const preview = resolveWorkfileMutationPreview(
    toolCall({
      input: {
        newString: "const title = 'New';",
        oldString: "const title = 'Old';",
        path: "/files/ppt/deck.js",
        replace_all: true,
      },
      output: {
        occurrences: 2,
        path: "/files/ppt/deck.js",
      },
      tool: "edit_file",
    }),
  );

  assert.equal(preview?.kind, "edit");
  assert.equal(preview?.path, "/files/ppt/deck.js");
  assert.equal(preview?.kind === "edit" ? preview.occurrences : null, 2);
  assert.equal(preview?.kind === "edit" ? preview.replaceAll : null, true);
  assert.equal(
    preview?.kind === "edit" ? preview.diffPreview : null,
    [
      "--- deck.js",
      "+++ deck.js",
      "-const title = 'Old';",
      "+const title = 'New';",
    ].join("\n"),
  );
});

test("resolveWorkfileMutationPreview handles edit_file replacements to empty string", () => {
  const preview = resolveWorkfileMutationPreview(
    toolCall({
      input: {
        newString: "",
        oldString: "const title = 'Old';",
        path: "/files/ppt/deck.js",
      },
      output: {
        occurrences: 1,
        path: "/files/ppt/deck.js",
      },
      tool: "edit_file",
    }),
  );

  assert.equal(preview?.kind, "edit");
  assert.equal(
    preview?.kind === "edit" ? preview.diffPreview : null,
    ["--- deck.js", "+++ deck.js", "-const title = 'Old';", "+"].join("\n"),
  );
});

test("resolveWorkfileMutationPreview also previews sandbox (/workspace) code", () => {
  const preview = resolveWorkfileMutationPreview(
    toolCall({
      input: {
        content: "print('hi')\n",
        path: "/workspace/main.py",
      },
      tool: "write_file",
    }),
  );

  assert.equal(preview?.kind, "write");
  assert.equal(preview?.path, "/workspace/main.py");
  assert.equal(preview?.kind === "write" ? preview.language : null, "python");
});

test("getWorkfileMutationToolTitle labels sandbox writes distinctly", () => {
  assert.equal(
    getWorkfileMutationToolTitle(
      toolCall({
        input: { content: "x", path: "/workspace/main.py" },
        tool: "write_file",
      }),
      t,
    ),
    "Wrote sandbox file: main.py",
  );
  assert.equal(
    getWorkfileMutationToolTitle(
      toolCall({
        input: { content: "x", path: "/files/a.py" },
        tool: "write_file",
      }),
      t,
    ),
    "Wrote Workfile: a.py",
  );
});

test("resolveWorkfileMutationPreview ignores non-workfile paths", () => {
  assert.equal(
    resolveWorkfileMutationPreview(
      toolCall({
        input: {
          content: "hidden",
          path: "/skills/ppt-deck/SKILL.md",
        },
        tool: "write_file",
      }),
    ),
    null,
  );
});
