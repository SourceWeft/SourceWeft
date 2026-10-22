import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { PUBLISHED_ARTIFACT_NEXT_STEP } from "@sourceweft/contracts/agent-tools";
import { collectToolStreamEvents } from "../../../../test/turn-stream-collectors";
import { buildFinalOutcome } from "./final-outcome";
import { buildDeepAgentTodosStep } from "./tool-tracker";
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
    buildFinalOutcome({
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
    buildFinalOutcome({
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

test("final outcome closes the in-progress todo after a committed publish", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-final-todos",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  runtime.assistantContent = "Published the report.";
  runtime.hasStreamedText = true;
  const todos = [
    { content: "Draft the report", status: "completed" as const },
    { content: "Publish and summarize", status: "in_progress" as const },
  ];
  runtime.setThinkingStep(
    buildDeepAgentTodosStep({ toolCallId: "call-todos", todos }),
  );
  for (const [id, tool, output] of [
    ["call-todos", "write_todos", "Updated todo list"],
    [
      "call-publish",
      "publish_artifact",
      JSON.stringify({
        ok: true,
        type: "html_artifact_result",
        status: "ready",
        nextStep: PUBLISHED_ARTIFACT_NEXT_STEP,
        artifactType: "html",
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
      }),
    ],
  ] as const) {
    runtime.toolCallOrder.push(id);
    runtime.toolCallsById.set(id, {
      id,
      tool,
      input: {},
      output,
      status: "completed",
      error: null,
      latencyMs: 1,
      sequence: runtime.resolveToolCallSequence(id),
    });
  }

  const events = await collectToolStreamEvents(
    buildFinalOutcome({
      agent: { getState: vi.fn().mockResolvedValue(null) } as never,
      beforeAssistantCheckpoint: null,
      beforeInputCheckpoint: null,
      finalCheckpoint: null,
      prepared: {
        assistantMessageId: "assistant-1",
        commandSuccessCriteria: { kind: "none" },
        runTraceId: "trace-final-todos",
      } as never,
      runConfig: {} as never,
      runtime,
    }),
  );
  const todoEvents = events.filter(
    (event) =>
      event.type === "thinking-step" && event.step.id === "deepagents:todos",
  );
  assert.equal(todoEvents.length, 1);
  const done = events.find((event) => event.type === "done");
  const persisted =
    done?.type === "done"
      ? done.outcome.thinkingSteps?.find(
          (step) => step.id === "deepagents:todos",
        )
      : undefined;
  for (const step of [
    todoEvents[0]?.type === "thinking-step" ? todoEvents[0].step : undefined,
    persisted,
  ]) {
    assert.equal(step?.status, "completed");
    assert.deepEqual(step?.items, [
      "Completed: Draft the report",
      "Completed: Publish and summarize",
    ]);
    assert.equal(step?.metadata?.closedBy, "committed_delivery");
    // The step keeps its original place in the trace.
    assert.equal(step?.sequence, 1);
  }
});
