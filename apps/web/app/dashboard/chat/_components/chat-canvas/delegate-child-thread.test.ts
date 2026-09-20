import { describe, expect, it } from "vitest";

import {
  extractReport,
  parseDelegateToolCall,
  readDelegateChildThreadId,
} from "./delegate-tool-card-state";
import type { ToolCallRecord } from "./types";

function taskCall(
  output: unknown,
  status: ToolCallRecord["status"] = "completed",
): ToolCallRecord {
  return {
    id: "task-1",
    tool: "task",
    input: { subagent_type: "explore", description: "Verify 1+1=2." },
    output,
    latencyMs: 10,
    status,
    error: null,
  };
}

describe("readDelegateChildThreadId", () => {
  it("reads the server's namespaced tag off a wrapped report", () => {
    expect(
      readDelegateChildThreadId({
        report: "done",
        sourceweft: { childThreadId: "thread_child" },
      }),
    ).toBe("thread_child");
  });

  it("reads the tag off a Command result too", () => {
    expect(
      readDelegateChildThreadId({
        lg_name: "Command",
        update: { messages: [] },
        sourceweft: { childThreadId: "thread_child" },
      }),
    ).toBe("thread_child");
  });

  it("is null for untagged, blank, or non-object output", () => {
    expect(readDelegateChildThreadId("done")).toBeNull();
    expect(readDelegateChildThreadId({ report: "done" })).toBeNull();
    expect(
      readDelegateChildThreadId({ sourceweft: { childThreadId: "" } }),
    ).toBeNull();
    expect(readDelegateChildThreadId(null)).toBeNull();
  });
});

describe("parseDelegateToolCall with a projected child thread", () => {
  it("keeps the report readable and exposes the child thread", () => {
    const view = parseDelegateToolCall(
      taskCall({
        report: "done",
        sourceweft: { childThreadId: "thread_child" },
      }),
    );
    expect(view.report).toBe("done");
    expect(view.childThreadId).toBe("thread_child");
    expect(view.subagentType).toBe("explore");
  });

  it("has no child thread while running or when the server did not project", () => {
    expect(
      parseDelegateToolCall(taskCall(null, "running")).childThreadId,
    ).toBeNull();
    expect(parseDelegateToolCall(taskCall("done")).childThreadId).toBeNull();
    expect(parseDelegateToolCall(taskCall("done")).report).toBe("done");
  });
});

describe("extractReport", () => {
  it("prefers the Command's last ToolMessage, then the wrapped report", () => {
    expect(
      extractReport({
        update: { messages: [{ kwargs: { content: "from command" } }] },
        report: "ignored",
      }),
    ).toBe("from command");
    expect(extractReport({ report: "wrapped" })).toBe("wrapped");
    expect(extractReport({ report: "" })).toBeNull();
  });
});
