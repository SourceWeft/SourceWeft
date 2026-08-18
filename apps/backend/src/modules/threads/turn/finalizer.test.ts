import assert from "node:assert/strict";
import { test } from "vitest";
import { testExports } from "./finalizer";

test("assistant continuation content appends resumed text to pre-approval text", () => {
  assert.equal(
    testExports.appendAssistantContinuationContent({
      existingContent: "The oldest page is page-1 (08:54 UTC",
      nextContent: "Deleted page-1 (08:54 UTC). 4 pages remain.",
    }),
    "The oldest page is page-1 (08:54 UTC\nDeleted page-1 (08:54 UTC). 4 pages remain.",
  );
});

test("assistant continuation content stitches overlapping resume text", () => {
  assert.equal(
    testExports.appendAssistantContinuationContent({
      existingContent: "The oldest page is page-1 (08:54 UTC",
      nextContent: "UTC) has been deleted. 4 pages remain.",
    }),
    "The oldest page is page-1 (08:54 UTC) has been deleted. 4 pages remain.",
  );
});

test("assistant continuation content avoids duplicating already-prefixed text", () => {
  assert.equal(
    testExports.appendAssistantContinuationContent({
      existingContent: "Before approval",
      nextContent: "Before approval\nAfter approval",
    }),
    "Before approval\nAfter approval",
  );
  assert.equal(
    testExports.appendAssistantContinuationContent({
      existingContent: "Before approval\nAfter approval",
      nextContent: "After approval",
    }),
    "Before approval\nAfter approval",
  );
});

test("assistant continuation content keeps existing text for empty resume text", () => {
  assert.equal(
    testExports.appendAssistantContinuationContent({
      existingContent: "Before approval",
      nextContent: "",
    }),
    "Before approval",
  );
});

test("continuation metadata preserves append-only trace events", () => {
  const metadata = testExports.preserveAssistantMetadataForContinuation({
    existingMetadata: {
      finishReason: "tool_confirmation_requested",
      reasoning: "before approval",
      traceEvents: [
        {
          type: "reasoning",
          id: "reasoning:segment-1:1",
          itemId: "segment-1",
          sequence: 1,
          segment: {
            id: "segment-1",
            text: "Need to search.",
            sequence: 1,
          },
        },
        {
          type: "tool-call",
          id: "tool-call:search-page:2",
          itemId: "search-page",
          sequence: 2,
          eventType: "tool-call-result",
          toolCall: {
            id: "search-page",
            tool: "search_notion_pages",
            input: {},
            output: null,
            status: "completed",
            sequence: 2,
          },
        },
      ],
      traceParts: [
        {
          id: "reasoning:segment-1",
          kind: "reasoning",
          order: 0,
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
          text: "Need to search.",
        },
        {
          id: "tool:search-page",
          kind: "tool",
          order: 1,
          createdAt: "2026-05-25T00:00:01.000Z",
          updatedAt: "2026-05-25T00:00:01.000Z",
          toolCallId: "search-page",
          tool: "search_notion_pages",
          input: {},
          output: null,
          status: "completed",
        },
        {
          id: "tool:create-page",
          kind: "tool",
          order: 2,
          createdAt: "2026-05-25T00:00:02.000Z",
          updatedAt: "2026-05-25T00:00:02.000Z",
          toolCallId: "create-page",
          tool: "create_notion_page",
          input: {},
          output: {
            type: "tool_confirmation_request",
            id: "confirmation-1",
            status: "proposed",
          },
          status: "approval_requested",
          approvalConfirmationId: "confirmation-1",
        },
      ],
      reasoningSegments: [
        {
          id: "segment-1",
          text: "Need to search.",
          sequence: 1,
        },
      ],
      toolCalls: [
        {
          id: "search-page",
          tool: "search_notion_pages",
          input: {},
          output: null,
          status: "completed",
          sequence: 2,
        },
        {
          id: "create-page",
          tool: "create_notion_page",
          input: {},
          output: {
            type: "tool_confirmation_request",
            id: "confirmation-1",
            status: "proposed",
          },
          status: "approval_requested",
          sequence: 4,
          approvalConfirmationId: "confirmation-1",
        },
      ],
    },
    nextMetadata: {
      finishReason: "stop",
      reasoning: "after approval",
      traceEvents: [
        {
          type: "tool-call",
          id: "tool-call:create-page:4",
          itemId: "create-page",
          sequence: 4,
          eventType: "tool-call-result",
          toolCall: {
            id: "create-page",
            tool: "create_notion_page",
            input: {},
            output: {
              type: "connector_tool_result",
              pageId: "page-1",
            },
            status: "completed",
            sequence: 4,
            approvalState: "approved",
            approvalConfirmationId: "confirmation-1",
          },
        },
        {
          type: "reasoning",
          id: "reasoning:segment-2:5",
          itemId: "segment-2",
          sequence: 5,
          segment: {
            id: "segment-2",
            text: "Page created.",
            sequence: 5,
            toolCallId: "create-page",
          },
        },
      ],
      traceParts: [
        {
          id: "tool:create-page",
          kind: "tool",
          order: 0,
          createdAt: "2026-05-25T00:01:00.000Z",
          updatedAt: "2026-05-25T00:01:00.000Z",
          toolCallId: "create-page",
          tool: "create_notion_page",
          input: {},
          output: {
            type: "connector_tool_result",
            pageId: "page-1",
          },
          status: "completed",
          approvalState: "approved",
          approvalConfirmationId: "confirmation-1",
        },
        {
          id: "reasoning:segment-2",
          kind: "reasoning",
          order: 1,
          createdAt: "2026-05-25T00:01:01.000Z",
          updatedAt: "2026-05-25T00:01:01.000Z",
          text: "Page created.",
          toolCallId: "create-page",
        },
      ],
      reasoningSegments: [
        {
          id: "segment-2",
          text: "Page created.",
          sequence: 5,
          toolCallId: "create-page",
        },
      ],
      toolCalls: [
        {
          id: "create-page",
          tool: "create_notion_page",
          input: {},
          output: {
            type: "connector_tool_result",
            pageId: "page-1",
          },
          status: "completed",
          sequence: 4,
          approvalState: "approved",
          approvalConfirmationId: "confirmation-1",
        },
      ],
    },
  });

  assert.deepEqual(
    (metadata.traceEvents as Array<{ id: string; sequence: number }>).map(
      (item) => `${item.sequence}:${item.id}`,
    ),
    [
      "1:reasoning:segment-1:1",
      "2:tool-call:search-page:2",
      "4:tool-call:create-page:4",
      "5:reasoning:segment-2:5",
    ],
  );
  assert.deepEqual(
    (
      metadata.traceEvents as Array<{
        displayOrder?: number;
        id: string;
        sequence: number;
      }>
    ).map((item) => `${item.displayOrder}:${item.sequence}:${item.id}`),
    [
      "0:1:reasoning:segment-1:1",
      "1:2:tool-call:search-page:2",
      "2:4:tool-call:create-page:4",
      "3:5:reasoning:segment-2:5",
    ],
  );
  assert.deepEqual(
    (metadata.reasoningSegments as Array<{ id: string; sequence: number }>).map(
      (item) => `${item.sequence}:${item.id}`,
    ),
    ["1:segment-1", "5:segment-2"],
  );
  assert.deepEqual(
    (
      metadata.toolCalls as Array<{
        approvalConfirmationId?: string;
        approvalState?: string;
        id: string;
        sequence: number;
        status: string;
      }>
    ).map(
      (item) =>
        `${item.sequence}:${item.id}:${item.status}:${item.approvalState ?? ""}:${item.approvalConfirmationId ?? ""}`,
    ),
    [
      "2:search-page:completed::",
      "4:create-page:completed:approved:confirmation-1",
    ],
  );
  assert.deepEqual(
    (
      metadata.traceParts as Array<{
        approvalConfirmationId?: string;
        approvalState?: string;
        kind: string;
        order: number;
        status?: string;
        toolCallId?: string;
      }>
    ).map(
      (item) =>
        `${item.order}:${item.kind}:${item.toolCallId ?? ""}:${item.status ?? ""}:${item.approvalState ?? ""}:${item.approvalConfirmationId ?? ""}`,
    ),
    [
      "0:reasoning::::",
      "1:tool:search-page:completed::",
      "2:tool:create-page:completed:approved:confirmation-1",
      "3:reasoning:create-page:::",
    ],
  );
});

test("continuation metadata replaces render blocks from resumed runs", () => {
  const metadata = testExports.preserveAssistantMetadataForContinuation({
    existingMetadata: {
      renderBlocks: [
        { id: "reasoning-1", type: "reasoning", text: "Search pages." },
        { id: "tool-1", type: "tool", toolCallId: "search-page" },
        { id: "text-1", type: "text", text: "Found pages." },
      ],
    },
    nextMetadata: {
      renderBlocks: [
        { id: "text-1", type: "text", text: "Rejected. Present summary." },
      ],
    },
  });

  assert.deepEqual(metadata.renderBlocks, [
    {
      id: "text-1",
      type: "text",
      text: "Rejected. Present summary.",
    },
  ]);
});

test("finalization preserves artifact outputs committed by a background worker", () => {
  const output = {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    id: "artifact-output:run-1:artifact-1:version-1",
    placement: "terminal",
    producer: { kind: "main" },
    sequence: 1,
    sourceToolCallId: "video-tool",
    threadRunId: "run-1",
    type: "artifact_output",
  };
  const metadata = testExports.preserveAssistantMetadataForContinuation({
    existingMetadata: { renderBlocks: [output] },
    nextMetadata: {
      renderBlocks: [
        { id: "tool-video", type: "tool", toolCallId: "video-tool" },
      ],
    },
  });

  assert.deepEqual(metadata.renderBlocks, [
    { id: "tool-video", type: "tool", toolCallId: "video-tool" },
    output,
  ]);
});

test("continuation metadata does not rewrite duplicate reasoning ids with new sequences", () => {
  const metadata = testExports.preserveAssistantMetadataForContinuation({
    existingMetadata: {
      traceEvents: [
        {
          type: "reasoning",
          id: "reasoning:model-reasoning-1:1",
          itemId: "model-reasoning-1",
          sequence: 1,
          segment: {
            id: "model-reasoning-1",
            text: "before approval",
            sequence: 1,
          },
        },
      ],
      reasoningSegments: [
        {
          id: "model-reasoning-1",
          text: "before approval",
          sequence: 1,
        },
      ],
    },
    nextMetadata: {
      traceEvents: [
        {
          type: "reasoning",
          id: "reasoning:model-reasoning-1:5",
          itemId: "model-reasoning-1",
          sequence: 5,
          segment: {
            id: "model-reasoning-1",
            text: "after approval",
            sequence: 5,
            toolCallId: "create-page",
          },
        },
      ],
      reasoningSegments: [
        {
          id: "model-reasoning-1:5",
          text: "after approval",
          sequence: 5,
          toolCallId: "create-page",
        },
      ],
    },
  });

  assert.deepEqual(
    (metadata.traceEvents as Array<{ id: string; sequence: number }>).map(
      (item) => `${item.sequence}:${item.id}`,
    ),
    [
      "1:reasoning:model-reasoning-1:1",
      "5:reasoning:model-reasoning-1:5",
    ],
  );
  assert.deepEqual(
    (metadata.reasoningSegments as Array<{ id: string; sequence: number }>).map(
      (item) => `${item.sequence}:${item.id}`,
    ),
    ["1:model-reasoning-1", "5:model-reasoning-1:5"],
  );
});
