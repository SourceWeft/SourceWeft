import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { config } from "../../../shared/config";

vi.mock("../../../shared/queue", () => ({
  enqueueWithAudit: vi.fn(),
  jobsQueue: { getJob: vi.fn() },
}));
vi.mock("../../../shared/model-gateway/system-client", () => ({
  getSystemModelReadiness: vi.fn(),
}));

import {
  enqueueMcpSummaryTranslation,
  MCP_SUMMARY_TRANSLATION_SCHEDULED_JOB_ID,
  type EnqueueMcpSummaryTranslationDeps,
} from "./summary-translation-queue";

function deps(input: { ready: boolean; exists?: boolean }) {
  return {
    modelReady: vi.fn(async () => input.ready),
    jobExists: vi.fn(async () => input.exists ?? false),
    enqueue: vi.fn(async () => undefined),
  } satisfies EnqueueMcpSummaryTranslationDeps;
}

describe("queueing a translation pass", () => {
  test("no translation pass is queued at peak hours with the option enabled", async () => {
    const original = config.market.aiOffPeakOnly;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T01:00Z"));
    config.market.aiOffPeakOnly = true;
    try {
      const d = deps({ ready: true });
      assert.equal(await enqueueMcpSummaryTranslation(d), false);
      assert.equal(d.modelReady.mock.calls.length, 0);
      assert.equal(d.enqueue.mock.calls.length, 0);
    } finally {
      config.market.aiOffPeakOnly = original;
      vi.useRealTimers();
    }
  });
  test("queues one pass under the scheduled job id", async () => {
    const d = deps({ ready: true });
    assert.equal(await enqueueMcpSummaryTranslation(d), true);
    assert.deepEqual(d.enqueue.mock.calls, [
      [MCP_SUMMARY_TRANSLATION_SCHEDULED_JOB_ID],
    ]);
  });

  test("queues nothing while the system model is not ready: no no-op jobs or audit rows", async () => {
    const d = deps({ ready: false });
    assert.equal(await enqueueMcpSummaryTranslation(d), false);
    assert.equal(d.enqueue.mock.calls.length, 0);
    assert.equal(d.jobExists.mock.calls.length, 0);
  });

  test("is single-flight: nothing while the previous pass is queued or running", async () => {
    const d = deps({ ready: true, exists: true });
    assert.equal(await enqueueMcpSummaryTranslation(d), false);
    assert.equal(d.enqueue.mock.calls.length, 0);
  });
});
