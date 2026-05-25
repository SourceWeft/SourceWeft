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
