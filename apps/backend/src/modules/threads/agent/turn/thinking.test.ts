import assert from "node:assert/strict";
import { test } from "vitest";
import { testExports } from "./runner";

test("model reasoning segment ids include the run trace id", () => {
  assert.equal(
    testExports.createModelReasoningSegmentId({
      runTraceId: "trace-1",
      index: 2,
    }),
    "model-reasoning:trace-1:2",
  );
});
