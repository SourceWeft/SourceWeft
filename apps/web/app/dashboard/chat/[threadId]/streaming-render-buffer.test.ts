import assert from "node:assert/strict";
import { test } from "vitest";
import { createStreamingRenderBuffer } from "./streaming-render-buffer";

test("keeps assistant text, tool block, and continued text in order", () => {
  const buffer = createStreamingRenderBuffer({ maxDeltaBatchChars: 800 });

  buffer.appendText("before");
  buffer.appendToolBlock("tool-1");
  buffer.appendText("after");

  assert.deepEqual(buffer.snapshotRenderBlocks(), [
    {
      id: "stream-text-1",
      type: "text",
      text: "before",
    },
    {
      id: "stream-tool-tool-1",
      type: "tool",
      toolCallId: "tool-1",
    },
    {
      id: "stream-text-2",
      type: "text",
      text: "after",
    },
  ]);
});

test("replaces streamed blocks with committed artifact outputs", () => {
  const buffer = createStreamingRenderBuffer({ maxDeltaBatchChars: 800 });

  buffer.replaceRenderBlocks([
    {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      id: "artifact-output:run-1:artifact-1:version-1",
      placement: "terminal",
      producer: { kind: "main" },
      sequence: 1,
      sourceToolCallId: "tool-1",
      threadRunId: "run-1",
      type: "artifact_output",
    },
  ]);

  assert.deepEqual(buffer.snapshotRenderBlocks(), [
    {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      id: "artifact-output:run-1:artifact-1:version-1",
      placement: "terminal",
      producer: { kind: "main" },
      sequence: 1,
      sourceToolCallId: "tool-1",
      threadRunId: "run-1",
      type: "artifact_output",
    },
  ]);
});

test("deduplicates tool blocks by tool call id", () => {
  const buffer = createStreamingRenderBuffer({ maxDeltaBatchChars: 800 });

  buffer.appendToolBlock("tool-1");
  buffer.appendToolBlock("tool-1");

  assert.deepEqual(buffer.snapshotRenderBlocks(), [
    {
      id: "stream-tool-tool-1",
      type: "tool",
      toolCallId: "tool-1",
    },
  ]);
});

test("replaceText preserves existing text segmentation when final text has same prefix", () => {
  const buffer = createStreamingRenderBuffer({ maxDeltaBatchChars: 800 });

  buffer.appendText("summary");
  buffer.appendToolBlock("tool-1");
  buffer.appendText("next");
  buffer.replaceText("summarynext done");

  assert.deepEqual(buffer.snapshotRenderBlocks(), [
    {
      id: "stream-text-1",
      type: "text",
      text: "summary",
    },
    {
      id: "stream-tool-tool-1",
      type: "tool",
      toolCallId: "tool-1",
    },
    {
      id: "stream-text-2",
      type: "text",
      text: "next done",
    },
  ]);
});
