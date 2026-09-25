import assert from "node:assert/strict";
import { test } from "vitest";
import { createModelReasoningSegmentId } from "./thinking";

test("model reasoning segment ids include the run trace id", () => {
  assert.equal(
    createModelReasoningSegmentId({
      runTraceId: "trace-1",
      index: 2,
    }),
    "model-reasoning:trace-1:2",
  );
});
