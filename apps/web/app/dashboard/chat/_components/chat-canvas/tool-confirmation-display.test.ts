import assert from "node:assert/strict";
import { test } from "vitest";
import { createTranslator } from "next-intl";
import type { useTranslations } from "next-intl";
import {
  confirmationTitle,
  requestDetailLines,
} from "./tool-confirmation-display";
import type { ToolConfirmationRequest } from "@sourceweft/sdk";
import messages from "../../../../../messages/en.json";

// Server-side translator (no React context); the en catalog carries the same
// English these helpers used to hardcode, so the assertions still hold. The cast
// pins it to the loose translator type the helpers accept.
const t = createTranslator({
  locale: "en",
  messages,
  namespace: "dashboardChatCanvas",
}) as unknown as ReturnType<typeof useTranslations>;

function confirmation(
  input: {
    actionLabel?: string;
    actionDescription?: string;
    previewSummary?: string;
    previewTitle?: string;
    toolName?: string;
  } = {},
): Pick<ToolConfirmationRequest, "action" | "preview"> {
  return {
    action: {
      type: "notion.page.trash",
      toolName: input.toolName ?? "delete_notion_page",
      label: input.actionLabel ?? "Trash",
      ...(input.actionDescription
        ? { description: input.actionDescription }
        : {}),
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: input.previewTitle ?? "notion.page.trash on page_1",
      summary: input.previewSummary ?? "notion.page.trash on page_1",
    },
  };
}

test("confirmation display uses agent tool metadata for legacy internal action labels", () => {
  const legacyConfirmation = confirmation();

  assert.equal(confirmationTitle(legacyConfirmation, t), "Delete Notion page");
  assert.deepEqual(requestDetailLines(legacyConfirmation, undefined, t), [
    "Target: page_1",
    "Move Notion pages to trash by page ID",
  ]);
});

test("confirmation display prefers payload action description when provided", () => {
  const describedConfirmation = confirmation({
    actionDescription:
      "Move one or more existing Notion pages to trash by page ID.",
    actionLabel: "Move Notion page to trash",
    previewSummary: "notion.page.trash on 2 pages",
  });

  assert.equal(
    confirmationTitle(describedConfirmation, t),
    "Move Notion page to trash",
  );
  assert.deepEqual(requestDetailLines(describedConfirmation, undefined, t), [
    "Target: 2 pages",
    "Move one or more existing Notion pages to trash by page ID.",
  ]);
});

test("confirmation display shows sandbox prepare review details", () => {
  const sandboxConfirmation = confirmation({
    toolName: "prepare_sandbox_workspace",
  });
  sandboxConfirmation.action.label = "Prepare sandbox workspace";
  sandboxConfirmation.preview.requestJson = {
    files: [
      {
        sourcePath: "/files/input.md",
        sandboxPath: "/workspace/input/input.md",
        sizeBytes: 2048,
      },
    ],
  };

  assert.deepEqual(requestDetailLines(sandboxConfirmation, undefined, t), [
    "Risk: High",
    "Prepare 1 file",
    "/files/input.md -> /workspace/input/input.md · 2.0 KB",
    "Selected SourceWeft /files Workfile content will be materialized as ordinary sandbox files.",
  ]);
});

test("confirmation display shows sandbox execute review details", () => {
  const sandboxConfirmation = confirmation({ toolName: "execute" }) as Pick<
    ToolConfirmationRequest,
    "action" | "preview" | "editableArgs"
  >;
  sandboxConfirmation.action.label = "Run sandbox command";
  sandboxConfirmation.preview.requestJson = {
    command: "npm test",
    cwd: "/workspace/ppt-deck",
  };
  sandboxConfirmation.editableArgs = {
    value: { command: "npm test", cwd: "/workspace/ppt-deck" },
  };

  assert.deepEqual(requestDetailLines(sandboxConfirmation, undefined, t), [
    "Risk: High",
    "Command: npm test",
    "Working directory: /workspace/ppt-deck",
    "Review network, dependency, and secret-access risk before approving.",
    "Editable before approval",
  ]);
});

test("confirmation display shows sandbox collect review details", () => {
  const sandboxConfirmation = confirmation({
    toolName: "collect_sandbox_outputs",
  });
  sandboxConfirmation.action.label = "Collect sandbox outputs";
  sandboxConfirmation.preview.requestJson = {
    outputs: [
      {
        sandboxPath: "/workspace/output/report.md",
        target: {
          kind: "workfile",
          path: "/files/report.md",
          overwrite: true,
        },
        sizeBytes: 512,
      },
    ],
  };

  assert.deepEqual(requestDetailLines(sandboxConfirmation, undefined, t), [
    "Risk: High",
    "Collect 1 output",
    "/workspace/output/report.md -> /files/report.md · overwrite: yes · 512 B",
    "Outputs become durable only after collection into /files or a supported artifact path.",
  ]);
});

test("approval retains the complete local directory even when it is long", () => {
  const value = confirmation({ toolName: "execute" });
  const cwd = `/Users/example/Library/Application Support/${"project-".repeat(24)}/files`;
  value.preview.requestJson = { command: "pwd", cwd };
  assert.ok(
    requestDetailLines(value, undefined, t).includes(
      `Working directory: ${cwd}`,
    ),
  );
});
test("command approval never invents a cloud cwd when the directory is omitted", () => {
  const request = confirmation({ toolName: "execute" });
  request.action.type = "sandbox.execute";
  expectNoGuessedCloudPath(requestDetailLines(request, undefined, t));
});
function mcpConfirmation(): Pick<
  ToolConfirmationRequest,
  "action" | "preview" | "domain"
> {
  return {
    domain: "mcp",
    action: {
      type: "arcmira_youtube_search",
      toolName:
        "mcp__io_github_arcmira_arcmira_fd783434__arcmira_youtube_search",
      label: "arcmira_youtube_search",
      description: "Searches what was said in YouTube videos.",
      riskLevel: "medium",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "arcmira_youtube_search",
      summary: "Searches what was said in YouTube videos.",
      target: {
        type: "mcp_server",
        label: "Arcmira: YouTube Transcript Search",
      },
    },
  };
}

test("MCP approval lists each argument of the pending call", () => {
  assert.deepEqual(
    requestDetailLines(
      mcpConfirmation(),
      {
        query: "Node.js 24 LTS",
        limit: 8,
        after: "2025-09-01",
        filters: { channel: ["t3.gg"], podcasts: true },
        cursor: null,
        skipped: undefined,
      },
      t,
    ),
    [
      "Searches what was said in YouTube videos.",
      "Target: Arcmira: YouTube Transcript Search",
      "query: Node.js 24 LTS",
      "limit: 8",
      "after: 2025-09-01",
      'filters: {"channel":["t3.gg"],"podcasts":true}',
      "cursor: null",
    ],
  );
});

test("MCP approvals of the same tool with different arguments differ", () => {
  const first = requestDetailLines(
    mcpConfirmation(),
    { query: "Node.js 24 LTS" },
    t,
  );
  const second = requestDetailLines(
    mcpConfirmation(),
    { query: "Node.js 24 release upgrade" },
    t,
  );
  assert.notDeepEqual(first, second);
});

test("MCP approval shortens a long argument to one line", () => {
  const code = `const rows = await arcmira.search(${"'x', ".repeat(80)});\nreturn rows;`;
  const lines = requestDetailLines(mcpConfirmation(), { code }, t);
  const codeLine = lines.find((line) => line.startsWith("code: "));
  assert.ok(codeLine);
  assert.equal(codeLine.length, 160);
  assert.ok(codeLine.endsWith("…"));
  assert.ok(!codeLine.includes("\n"));
});

test("MCP approval falls back to the request arguments without tool input", () => {
  const value = mcpConfirmation();
  value.preview.requestJson = { query: "from preview" };
  assert.ok(
    requestDetailLines(value, undefined, t).includes("query: from preview"),
  );
});

test("non-MCP approvals do not list tool input", () => {
  assert.deepEqual(
    requestDetailLines(confirmation(), { pageId: "page_1" }, t),
    ["Target: page_1", "Move Notion pages to trash by page ID"],
  );
});

function expectNoGuessedCloudPath(lines: string[]) {
  assert.ok(!lines.some((line) => line === "CWD: /workspace"));
}
