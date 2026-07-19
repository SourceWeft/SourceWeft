import assert from "node:assert/strict";
import { test } from "vitest";
import { createMessageRenderBlockBuilder } from "./render-blocks";

test("replaceText preserves existing text segmentation when final text has same prefix", () => {
  const builder = createMessageRenderBlockBuilder();

  builder.appendText("summary");
  builder.appendTool("tool-1");
  builder.appendText("next");
  builder.replaceText("summarynext done");

  assert.deepEqual(builder.list(), [
    {
      id: "text-1",
      type: "text",
      text: "summary",
    },
    {
      id: "tool-tool-1",
      type: "tool",
      toolCallId: "tool-1",
    },
    {
      id: "text-2",
      type: "text",
      text: "next done",
    },
  ]);
});

test("marks artifact blocks as terminal placement", () => {
  const builder = createMessageRenderBlockBuilder();

  builder.appendArtifact("image-tool");
  builder.appendArtifact("presentation-tool");

  assert.deepEqual(builder.list(), [
    {
      id: "artifact-image-tool",
      placement: "terminal",
      type: "artifact",
      toolCallId: "image-tool",
    },
    {
      id: "artifact-presentation-tool",
      placement: "terminal",
      type: "artifact",
      toolCallId: "presentation-tool",
    },
  ]);
});
