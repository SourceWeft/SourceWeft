import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createTurnRuntime } from "./turn-runtime";

test("turn runtime measures reasoning duration per segment", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
  try {
    const runtime = createTurnRuntime({
      prepared: {
        runTraceId: "trace-reasoning-duration",
        workspace: { id: "workspace" },
        thread: { id: "thread" },
      } as never,
    });

    vi.advanceTimersByTime(1000);
    const first = runtime.appendReasoningSegment("first thought");
    vi.advanceTimersByTime(1200);
    runtime.appendReasoningSegment(" continued");
    assert.equal(first.durationMs, 1200);

    vi.advanceTimersByTime(5000);
    runtime.resetReasoningBoundary();
    runtime.nextReasoningContext = {
      phase: "after_tool",
      toolCallId: "call-sandbox",
      tool: "execute_sandbox_command",
    };

    vi.advanceTimersByTime(300);
    const second = runtime.appendReasoningSegment("second thought");
    vi.advanceTimersByTime(400);
    runtime.appendReasoningSegment(" done");

    assert.equal(second.durationMs, 400);
    assert.equal(second.phase, "after_tool");
    assert.equal(second.toolCallId, "call-sandbox");
    assert.equal(second.tool, "execute_sandbox_command");
  } finally {
    vi.useRealTimers();
  }
});
