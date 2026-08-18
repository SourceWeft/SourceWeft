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

test("orders, attributes, and deduplicates committed artifact outputs", () => {
  const builder = createMessageRenderBlockBuilder();

  builder.appendArtifactOutput({
    artifactId: "image-1",
    artifactVersionId: "image-v1",
    producer: { kind: "main" },
    sourceToolCallId: "image-tool",
    threadRunId: "run-1",
  });
  builder.appendArtifactOutput({
    artifactId: "slides-1",
    artifactVersionId: "slides-v1",
    producer: { kind: "subagent", subagentType: "general-purpose" },
    sourceToolCallId: "presentation-tool",
    threadRunId: "run-1",
  });
  builder.appendArtifactOutput({
    artifactId: "image-1",
    artifactVersionId: "image-v1",
    producer: { kind: "main" },
    sourceToolCallId: "retry-tool",
    threadRunId: "run-1",
  });

  assert.deepEqual(builder.list(), [
    {
      artifactId: "image-1",
      artifactVersionId: "image-v1",
      id: "artifact-output:run-1:image-1:image-v1",
      placement: "terminal",
      producer: { kind: "main" },
      sequence: 1,
      sourceToolCallId: "image-tool",
      threadRunId: "run-1",
      type: "artifact_output",
    },
    {
      artifactId: "slides-1",
      artifactVersionId: "slides-v1",
      id: "artifact-output:run-1:slides-1:slides-v1",
      placement: "terminal",
      producer: { kind: "subagent", subagentType: "general-purpose" },
      sequence: 2,
      sourceToolCallId: "presentation-tool",
      threadRunId: "run-1",
      type: "artifact_output",
    },
  ]);
});
