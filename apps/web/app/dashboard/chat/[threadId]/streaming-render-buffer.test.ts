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

test("keeps text, tool, artifact, and trailing text in order", () => {
  const buffer = createStreamingRenderBuffer({ maxDeltaBatchChars: 800 });

  buffer.appendText("before");
  buffer.appendToolBlock("tool-1");
  buffer.appendText("middle");
  buffer.appendArtifactBlock("tool-2");
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
      text: "middle",
    },
    {
      id: "stream-artifact-tool-2",
      placement: "terminal",
      type: "artifact",
      toolCallId: "tool-2",
    },
    {
      id: "stream-text-3",
      type: "text",
      text: "after",
    },
  ]);
});

test("marks artifact blocks as terminal placement", () => {
  const buffer = createStreamingRenderBuffer({ maxDeltaBatchChars: 800 });

  buffer.appendArtifactBlock("image-tool");
  buffer.appendArtifactBlock("presentation-tool");

  assert.deepEqual(buffer.snapshotRenderBlocks(), [
    {
      id: "stream-artifact-image-tool",
      placement: "terminal",
      type: "artifact",
      toolCallId: "image-tool",
    },
    {
      id: "stream-artifact-presentation-tool",
      placement: "terminal",
      type: "artifact",
      toolCallId: "presentation-tool",
    },
  ]);
});

test("deduplicates artifact blocks by tool call id", () => {
  const buffer = createStreamingRenderBuffer({ maxDeltaBatchChars: 800 });

  buffer.appendArtifactBlock("tool-1");
  buffer.appendArtifactBlock("tool-1");

  assert.deepEqual(buffer.snapshotRenderBlocks(), [
    {
      id: "stream-artifact-tool-1",
      placement: "terminal",
      type: "artifact",
      toolCallId: "tool-1",
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
