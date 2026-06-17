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

test("marks generated artifact blocks as terminal placement", () => {
  const builder = createMessageRenderBlockBuilder();

  builder.appendGeneratedImage("image-tool");
  builder.appendGeneratedPresentation("presentation-tool");

  assert.deepEqual(builder.list(), [
    {
      id: "generated-image-image-tool",
      placement: "terminal",
      type: "generated_image",
      toolCallId: "image-tool",
    },
    {
      id: "generated-presentation-presentation-tool",
      placement: "terminal",
      type: "generated_presentation",
      toolCallId: "presentation-tool",
    },
  ]);
});
