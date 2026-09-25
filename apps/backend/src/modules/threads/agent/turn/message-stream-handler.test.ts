import assert from "node:assert/strict";
import { test } from "vitest";
import { collectMessageStreamEvents } from "../../../../test/turn-stream-collectors";
import { createTurnRuntime } from "./turn-runtime";

test("messages stream handler yields reasoning before text deltas and records tool calls", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-messages",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  const events = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        contentBlocks: [
          { type: "reasoning", text: "thinking through sources" },
          { type: "text", text: "Here is the answer." },
        ],
        response_metadata: {
          finish_reason: "stop",
          model_name: "test-model",
        },
        tool_calls: [
          {
            id: "call-search",
            name: "search_sources",
            args: { query: "alpha" },
          },
        ],
      },
    ],
    commandSuccessCriteria: { kind: "none" },
    runtime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["reasoning", "text-delta"],
  );
  assert.equal(events[0]?.type, "reasoning");
  assert.equal(
    events[0]?.type === "reasoning" ? events[0].reasoning : null,
    "thinking through sources",
  );
  assert.equal(events[1]?.type, "text-delta");
  assert.equal(
    events[1]?.type === "text-delta" ? events[1].delta : null,
    "Here is the answer.",
  );
  assert.equal(runtime.assistantContent, "Here is the answer.");
  assert.equal(runtime.modelReasoning, "thinking through sources");
  assert.equal(runtime.finishReason, "stop");
  assert.equal(runtime.providerFields?.model_name, "test-model");
  assert.deepEqual(runtime.observedToolCallsById.get("call-search"), {
    id: "call-search",
    name: "search_sources",
    args: { query: "alpha" },
    index: 0,
  });
});

test("messages stream handler preserves whitespace across streamed reasoning chunks", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-reasoning-whitespace",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  const firstEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        contentBlocks: [{ type: "reasoning", text: "The user is " }],
      },
    ],
    commandSuccessCriteria: { kind: "none" },
    runtime,
    suppressModelReasoning: false,
  });

  const secondEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        contentBlocks: [
          { type: "reasoning", text: "asking about black holes." },
        ],
      },
    ],
    commandSuccessCriteria: { kind: "none" },
    runtime,
    suppressModelReasoning: false,
  });

  assert.equal(
    firstEvents[0]?.type === "reasoning" ? firstEvents[0].reasoning : null,
    "The user is ",
  );
  assert.equal(
    secondEvents[0]?.type === "reasoning" ? secondEvents[0].reasoning : null,
    "asking about black holes.",
  );
  assert.equal(runtime.modelReasoning, "The user is asking about black holes.");
});

test("messages stream handler promotes pending run id tool stream when LangChain tool call id arrives", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-message-promote",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const pendingStartedAt = Date.now() - 25;
  runtime.pendingToolStreamsByRunId.set("run-write", {
    normalizedInput: { path: "a.txt" },
    startedAt: pendingStartedAt,
    streamRunId: "run-write",
    toolName: "write_file",
  });

  const events = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-write",
            name: "write_file",
            args: { path: "a.txt" },
          },
        ],
      },
    ],
    commandSuccessCriteria: { kind: "none" },
    runtime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-call-start"],
  );
  assert.equal(
    events[0]?.type === "tool-call-start" ? events[0].id : null,
    "call-write",
  );
  assert.equal(runtime.pendingToolStreamsByRunId.size, 0);
  assert.equal(runtime.toolStartedAtById.get("call-write"), pendingStartedAt);
  const toolCall = runtime.collectToolCalls()[0];
  assert.equal(toolCall?.id, "call-write");
  assert.equal(toolCall?.tool, "write_file");
  assert.deepEqual(toolCall?.input, { path: "a.txt" });
  assert.equal(toolCall?.output, null);
  assert.equal(toolCall?.status, "completed");
  assert.equal(toolCall?.error, null);
  assert.equal(toolCall?.sequence, 1);
  assert.equal(typeof toolCall?.latencyMs, "number");
  assert.ok((toolCall?.latencyMs ?? 0) >= 0);
  assert.deepEqual(runtime.renderBlocks.list(), [
    { id: "tool-call-write", type: "tool", toolCallId: "call-write" },
  ]);
});

test("messages stream handler suppresses raw tool call text and keeps suppression active", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-raw-tool-call",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });

  const firstEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: '<tool_call name="publish_artifact">',
      },
    ],
    commandSuccessCriteria: {
      artifactType: "slides",
      kind: "artifact",
      toolName: "publish_artifact",
    },
    runtime,
    suppressModelReasoning: false,
  });
  const secondEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: '{"topic":"hidden"}',
      },
    ],
    commandSuccessCriteria: {
      artifactType: "slides",
      kind: "artifact",
      toolName: "publish_artifact",
    },
    runtime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, []);
  assert.equal(runtime.suppressRawToolCallText, true);
  assert.equal(runtime.assistantContent, "");
  assert.equal(runtime.hasStreamedText, false);
});

test("messages stream handler clears streamed text when leaked artifact specs appear", async () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-leaked-spec",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
  const criteria = {
    artifactType: "slides" as const,
    kind: "artifact" as const,
    toolName: "publish_artifact",
  };

  const firstEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: "Planning deck: ",
      },
    ],
    commandSuccessCriteria: criteria,
    runtime,
    suppressModelReasoning: false,
  });
  const secondEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: "artifact_url: /artifact-preview?artifactId=artifact-1",
      },
    ],
    commandSuccessCriteria: criteria,
    runtime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(
    firstEvents.map((event) => event.type),
    ["text-delta"],
  );
  assert.deepEqual(secondEvents, [{ type: "text-replace", text: "" }]);
  assert.equal(runtime.suppressLeakedCommandSpecText, true);
  assert.equal(runtime.assistantContent, "");
  assert.equal(runtime.hasStreamedText, false);
  assert.equal(runtime.hasTextSinceLastToolBoundary, false);
});
