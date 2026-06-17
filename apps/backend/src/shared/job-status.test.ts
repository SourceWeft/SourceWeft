import assert from "node:assert/strict";
import { test } from "vitest";
import { presentJobState } from "./job-status";

test("presentJobState returns running status for active jobs", () => {
  assert.deepEqual(
    presentJobState({
      id: "job-1",
      type: "source-parse",
      state: "active",
      createdAtMs: 1_000,
      processedAtMs: 2_000,
    }),
    {
      id: "job-1",
      type: "source-parse",
      status: "running",
      createdAt: "1970-01-01T00:00:01.000Z",
      updatedAt: "1970-01-01T00:00:02.000Z",
      progress: null,
      result: null,
      error: null,
    },
  );
});
