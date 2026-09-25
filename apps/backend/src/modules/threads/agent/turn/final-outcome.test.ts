import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { collectToolStreamEvents } from "../../../../test/turn-stream-collectors";
import { testExports } from "./runner";
import { createTurnRuntime } from "./turn-runtime";

test("final outcome promotes pending stream from final LangChain tool call id", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-final-promote",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  runtime.assistantContent = "Done.";
  runtime.pendingToolStreamsByRunId.set("run-write", {
    normalizedInput: { path: "a.txt" },
    streamRunId: "run-write",
    toolName: "write_file",
  });

  const events = await collectToolStreamEvents(
    testExports.buildFinalOutcome({
      agent: {
        getState: vi.fn().mockResolvedValue({
          config: {
            configurable: {
              thread_id: "agent-thread-1",
              checkpoint_id: "checkpoint-1",
              checkpoint_ns: "",
            },
          },
          values: {
            messages: [
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-write-final",
                    name: "write_file",
                    args: { path: "a.txt", content: "A" },
                  },
                ],
              },
            ],
          },
        }),
      } as never,
      beforeAssistantCheckpoint: null,
      beforeInputCheckpoint: null,
      finalCheckpoint: null,
      prepared: {
        assistantMessageId: "assistant-1",
        commandSuccessCriteria: { kind: "none" },
        runTraceId: "trace-final-promote",
      } as never,
      runConfig: {} as never,
      runtime,
    }),
  );
  const done = events.find((event) => event.type === "done");
  assert.equal(done?.type, "done");
  assert.deepEqual(
    done?.type === "done"
      ? done.outcome.toolCalls.map((toolCall) => toolCall.id)
      : [],
    ["call-write-final"],
  );
  assert.deepEqual(
    done?.type === "done" ? done.outcome.toolCalls[0]?.input : null,
    { path: "a.txt", content: "A" },
  );
  assert.deepEqual(done?.type === "done" ? done.outcome.renderBlocks : [], [
    {
      id: "tool-call-write-final",
      type: "tool",
      toolCallId: "call-write-final",
    },
    { id: "text-1", type: "text", text: "Done." },
  ]);
  assert.equal(runtime.pendingToolStreamsByRunId.size, 0);
});

test("final outcome drops pending stream without a real LangChain tool call id", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-final-drop-pending",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  runtime.assistantContent = "Done.";
  runtime.pendingToolStreamsByRunId.set("run-write", {
    normalizedInput: { path: "a.txt" },
    streamRunId: "run-write",
    toolName: "write_file",
  });

  const events = await collectToolStreamEvents(
    testExports.buildFinalOutcome({
      agent: { getState: vi.fn().mockResolvedValue(null) } as never,
      beforeAssistantCheckpoint: null,
      beforeInputCheckpoint: null,
      finalCheckpoint: null,
      prepared: {
        assistantMessageId: "assistant-1",
        commandSuccessCriteria: { kind: "none" },
        runTraceId: "trace-final-drop-pending",
      } as never,
      runConfig: {} as never,
      runtime,
    }),
  );
  const done = events.find((event) => event.type === "done");
  assert.equal(done?.type, "done");
  assert.deepEqual(done?.type === "done" ? done.outcome.toolCalls : [], []);
  assert.deepEqual(done?.type === "done" ? done.outcome.renderBlocks : [], [
    { id: "text-1", type: "text", text: "Done." },
  ]);
  assert.equal(runtime.pendingToolStreamsByRunId.size, 1);
});
