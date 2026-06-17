import assert from "node:assert/strict";
import { test } from "vitest";
import {
  confirmationTitle,
  requestDetailLines,
} from "./tool-confirmation-display";
import type { ToolConfirmationRequest } from "@sourceweft/sdk";

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

  assert.equal(confirmationTitle(legacyConfirmation), "Delete Notion page");
  assert.deepEqual(requestDetailLines(legacyConfirmation), [
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
    confirmationTitle(describedConfirmation),
    "Move Notion page to trash",
  );
  assert.deepEqual(requestDetailLines(describedConfirmation), [
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
        sourcePath: "/workfiles/input.md",
        sandboxPath: "/workspace/input/input.md",
        sizeBytes: 2048,
      },
    ],
  };

  assert.deepEqual(requestDetailLines(sandboxConfirmation), [
    "Risk: High",
    "Prepare 1 file",
    "/workfiles/input.md -> /workspace/input/input.md · 2.0 KB",
    "Selected SourceWeft /workfiles Workfile content will be materialized as ordinary sandbox files.",
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

  assert.deepEqual(requestDetailLines(sandboxConfirmation), [
    "Risk: High",
    "Command: npm test",
    "CWD: /workspace/ppt-deck",
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
          path: "/workfiles/report.md",
          overwrite: true,
        },
        sizeBytes: 512,
      },
    ],
  };

  assert.deepEqual(requestDetailLines(sandboxConfirmation), [
    "Risk: High",
    "Collect 1 output",
    "/workspace/output/report.md -> /workfiles/report.md · overwrite: yes · 512 B",
    "Outputs become durable only after collection into /workfiles or a supported artifact path.",
  ]);
});
