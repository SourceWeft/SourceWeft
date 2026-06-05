import assert from "node:assert/strict";
import { test } from "vitest";
import type { AssistantRenderSegment } from "./assistant-render-segments";
import { findLastAnswerSegmentId } from "./message-evidence";
import type { MessageVersion } from "./types";

test("findLastAnswerSegmentId returns the last non-empty answer segment", () => {
  const segments: AssistantRenderSegment[] = [
    {
      blocks: [{ id: "b1", text: "Earlier answer", type: "text" }],
      id: "answer-1",
      type: "answer",
    },
    {
      blocks: [{ id: "w1", text: "work", type: "reasoning" }],
      id: "workflow-2",
      type: "workflow",
    },
    {
      blocks: [{ id: "b2", text: "", type: "text" }],
      id: "answer-3",
      type: "answer",
    },
    {
      blocks: [{ id: "b3", text: "Final answer", type: "text" }],
      id: "answer-4",
      type: "answer",
    },
  ];

  assert.equal(
    findLastAnswerSegmentId({ segments, version: {} as MessageVersion }),
    "answer-4",
  );
});
