import assert from "node:assert/strict";
import { test } from "vitest";
import { presentJobState } from "./job-status";

test("presentJobState includes worker progress payload", () => {
  assert.deepEqual(
    presentJobState({
      id: "job-1",
      type: "video-presentation-render",
      state: "active",
      createdAtMs: 1_000,
      processedAtMs: 2_000,
      progress: {
        stage: "generating_audio",
        status: "running",
        slideNumber: 2,
      },
    }),
    {
      id: "job-1",
      type: "video-presentation-render",
      status: "running",
      createdAt: "1970-01-01T00:00:01.000Z",
      updatedAt: "1970-01-01T00:00:02.000Z",
      progress: {
        stage: "generating_audio",
        status: "running",
        slideNumber: 2,
      },
      result: null,
      error: null,
    },
  );
});
