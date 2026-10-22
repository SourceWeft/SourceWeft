import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { continuedCitationsEvent } from "./citation-tracker";
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

function createRuntime(runTraceId: string) {
  return createTurnRuntime({
    prepared: {
      runTraceId,
      workspace: { id: "workspace" },
      thread: { id: "thread" },
    } as never,
  });
}

test("discardModelOutputSince withdraws the failed attempt's segments, text, blocks and tool-arg buffers", () => {
  const runtime = createRuntime("trace-retry");
  // A completed first decision: reasoning + text, then the tool boundary.
  runtime.modelReasoning = "first";
  runtime.appendReasoningSegment("first");
  runtime.renderBlocks.appendReasoning({
    id: "model-reasoning:trace-retry:1",
    text: "first",
  });
  runtime.assistantContent = "Hello";
  runtime.renderBlocks.appendText("Hello");
  runtime.hasStreamedText = true;
  runtime.resetReasoningBoundary();
  runtime.partialToolArgsBySlot.set("0", {
    id: "old-call",
    name: "write_file",
    args: '{"content":"done"}',
    lastContentLength: 4,
  });
  runtime.toolCallsById.set("old-call", {
    id: "old-call",
    tool: "write_file",
    input: {},
    output: null,
    status: "completed",
    latencyMs: null,
    error: null,
    sequence: 1,
  });

  const boundary = runtime.captureModelCallBoundary(1);
  assert.equal(boundary.attempt, 1);
  assert.equal(boundary.segmentCount, 1);

  // The attempt streams a new segment, more text and a partial tool call.
  runtime.modelReasoning = "first" + "second";
  const failed = runtime.appendReasoningSegment("second");
  runtime.renderBlocks.appendReasoning({ id: failed.id, text: "second" });
  runtime.assistantContent += " world";
  runtime.renderBlocks.appendText(" world");
  runtime.finishReason = "length";
  runtime.partialToolArgsBySlot.set("1", {
    id: "new-call",
    name: "write_file",
    args: '{"content":"par',
    lastContentLength: 3,
  });

  const discarded = runtime.discardModelOutputSince(boundary);

  assert.deepEqual(discarded, {
    segmentIds: ["model-reasoning:trace-retry:2"],
    toolCallIds: ["new-call"],
    keepTextChars: 5,
    keepReasoningChars: 5,
    dropTextChars: " world".length,
    dropReasoningChars: "second".length,
  });
  assert.equal(runtime.assistantContent, "Hello");
  assert.equal(runtime.modelReasoning, "first");
  assert.equal(runtime.finishReason, undefined);
  assert.equal(runtime.currentReasoningSegment, null);
  assert.deepEqual(
    runtime.reasoningSegments.map((segment) => segment.id),
    ["model-reasoning:trace-retry:1"],
  );
  assert.deepEqual(
    runtime.renderBlocks
      .list()
      .map((block) => [
        block.type,
        block.type === "tool"
          ? block.toolCallId
          : block.type === "artifact_output"
            ? block.artifactId
            : block.text,
      ]),
    [
      ["reasoning", "first"],
      ["text", "Hello"],
    ],
  );
  assert.deepEqual([...runtime.partialToolArgsBySlot.keys()], ["0"]);

  // The retried attempt opens a fresh segment: id 2 is never reused.
  const retried = runtime.appendReasoningSegment("second again");
  assert.equal(retried.id, "model-reasoning:trace-retry:3");
  assert.deepEqual(
    runtime.reasoningSegments.map((segment) => segment.id),
    ["model-reasoning:trace-retry:1", "model-reasoning:trace-retry:3"],
  );
});

test("discardModelOutputSince restores an empty runtime when nothing had streamed", () => {
  const runtime = createRuntime("trace-empty");
  const boundary = runtime.captureModelCallBoundary(1);
  runtime.modelReasoning = "x";
  runtime.appendReasoningSegment("x");
  runtime.assistantContent = "y";
  runtime.renderBlocks.appendText("y");
  runtime.hasStreamedText = true;
  runtime.hasTextSinceLastToolBoundary = true;

  const discarded = runtime.discardModelOutputSince(boundary);
  assert.deepEqual(discarded, {
    segmentIds: ["model-reasoning:trace-empty:1"],
    toolCallIds: [],
    keepTextChars: 0,
    keepReasoningChars: 0,
    dropTextChars: 1,
    dropReasoningChars: 1,
  });
  assert.equal(runtime.modelReasoning, undefined);
  assert.equal(runtime.assistantContent, "");
  assert.equal(runtime.hasStreamedText, false);
  assert.equal(runtime.hasTextSinceLastToolBoundary, false);
  assert.deepEqual(runtime.reasoningSegments, []);
  assert.deepEqual(runtime.renderBlocks.list(), []);
});

test("discardModelOutputSince never reports a negative drop when the attempt itself shrank the text", () => {
  const runtime = createRuntime("trace-shrink");
  runtime.assistantContent = "before";
  runtime.renderBlocks.appendText("before");
  const boundary = runtime.captureModelCallBoundary(1);
  // A leaked-command-spec `text-replace ""` during the attempt.
  runtime.assistantContent = "";
  runtime.renderBlocks.replaceText("");

  const discarded = runtime.discardModelOutputSince(boundary);
  assert.equal(discarded.dropTextChars, 0);
  assert.equal(discarded.keepTextChars, 6);
  assert.equal(runtime.assistantContent, "before");
});

test("a resumed turn continues its message's citation registry", () => {
  const runtime = createTurnRuntime({
    prepared: {
      runTraceId: "trace-resume-citations",
      workspace: { id: "workspace" },
      thread: { id: "thread" },
      traceContinuation: {
        maxSequence: 0,
        toolSequenceById: {},
        citations: [
          {
            citation: "c1",
            sourceId: "source-1",
            sourceTitle: "Report",
            documentId: "document-1",
            chunkId: "chunk-1",
            chunkNo: 1,
            score: 1,
            excerpt: "Revenue",
            quoteText: "Revenue",
            origin: "read_file",
          },
          {
            citation: "c2",
            sourceId: null,
            sourceTitle: "Exports",
            documentId: null,
            chunkId: "external:https://example.com/exports",
            score: 1,
            excerpt: "Exports",
            quoteText: "Exports",
            origin: "web_fetch",
            externalUri: "https://example.com/exports",
          },
        ],
        citedCitationKeys: ["c2"],
      },
    } as never,
  });

  // The turn opens with the continued registry and the ids its text cites,
  // once: the tracker then reports only growth.
  const prepared = {
    traceContinuation: { citedCitationKeys: ["c2"] },
  } as never;
  const event = continuedCitationsEvent({
    prepared,
    getNewCitationSnapshot: runtime.getNewCitationSnapshot,
  });
  assert.deepEqual(
    event?.availableCitations?.map((citation) => citation.citation),
    ["c1", "c2"],
  );
  assert.deepEqual(
    event?.citations.map((citation) => citation.citation),
    ["c2"],
  );
  assert.equal(
    continuedCitationsEvent({
      prepared,
      getNewCitationSnapshot: runtime.getNewCitationSnapshot,
    }),
    null,
  );

  // Evidence seen before the pause keeps its id; new evidence is numbered after.
  const again = runtime.citationRegistry.addChunk({
    origin: "read_file",
    sourceId: "source-1",
    documentId: "document-1",
    chunkId: "chunk-1",
    chunkNo: 1,
    content: "Revenue",
  });
  assert.equal(again.citation, "c1");
  const fetched = runtime.citationRegistry.addExternal({
    origin: "web_fetch",
    externalUri: "https://example.com/exports",
    content: "Exports",
  });
  assert.equal(fetched.citation, "c2");
  const added = runtime.citationRegistry.addChunk({
    origin: "read_file",
    sourceId: "source-3",
    documentId: "document-3",
    chunkId: "chunk-3",
    chunkNo: 3,
    content: "Margins",
  });
  assert.equal(added.citation, "c3");
});
