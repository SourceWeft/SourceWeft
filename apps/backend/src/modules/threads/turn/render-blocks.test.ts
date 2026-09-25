import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createMessageRenderBlockBuilder,
  finalizeMessageRenderBlocks,
} from "./render-blocks";

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

describe("from runner.test.ts", () => {
  test("builds generated image render blocks in event order", () => {
    const builder = createMessageRenderBlockBuilder();

    builder.appendText("Intro\n");
    builder.appendArtifactOutput({
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      producer: { kind: "main" },
      sourceToolCallId: "tool-1",
      threadRunId: "run-1",
    });
    builder.appendText("\nDetails");

    assert.deepEqual(
      finalizeMessageRenderBlocks({
        blocks: builder.list(),
        finalText: "Intro\n\nDetails",
      }),
      [
        {
          id: "text-1",
          type: "text",
          text: "Intro\n",
        },
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
        {
          id: "text-2",
          type: "text",
          text: "\nDetails",
        },
      ],
    );
  });

  test("builds generic tool render blocks in event order", () => {
    const builder = createMessageRenderBlockBuilder();

    builder.appendText("Before tool");
    builder.appendTool("tool-1");
    builder.appendText("After tool");

    assert.deepEqual(
      finalizeMessageRenderBlocks({
        blocks: builder.list(),
        finalText: "Before toolAfter tool",
      }),
      [
        {
          id: "text-1",
          type: "text",
          text: "Before tool",
        },
        {
          id: "tool-tool-1",
          type: "tool",
          toolCallId: "tool-1",
        },
        {
          id: "text-2",
          type: "text",
          text: "After tool",
        },
      ],
    );
  });

  test("builds generated presentation render blocks in event order", () => {
    const builder = createMessageRenderBlockBuilder();

    builder.appendText("Intro\n");
    builder.appendArtifactOutput({
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      producer: { kind: "main" },
      sourceToolCallId: "tool-1",
      threadRunId: "run-1",
    });
    builder.appendText("\nHere is the deck summary.");

    assert.deepEqual(
      finalizeMessageRenderBlocks({
        blocks: builder.list(),
        finalText: "Intro\n\nHere is the deck summary.",
      }),
      [
        {
          id: "text-1",
          type: "text",
          text: "Intro\n",
        },
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
        {
          id: "text-2",
          type: "text",
          text: "\nHere is the deck summary.",
        },
      ],
    );
  });

  test("can clear leaked planning text while preserving generated artifact blocks", () => {
    const builder = createMessageRenderBlockBuilder();

    builder.appendText('{"schemaVersion":1,"slides":[]}');
    builder.appendArtifactOutput({
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      producer: { kind: "main" },
      sourceToolCallId: "tool-1",
      threadRunId: "run-1",
    });
    builder.replaceText("");

    assert.deepEqual(
      finalizeMessageRenderBlocks({
        blocks: builder.list(),
        finalText: "",
      }),
      [
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
      ],
    );
  });

  test("preserves render blocks when final text diverges", () => {
    const builder = createMessageRenderBlockBuilder();

    builder.appendText("Before citation [citation:missing]");
    builder.appendArtifactOutput({
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      producer: { kind: "main" },
      sourceToolCallId: "tool-1",
      threadRunId: "run-1",
    });

    assert.deepEqual(
      finalizeMessageRenderBlocks({
        blocks: builder.list(),
        finalText: "Before citation",
      }),
      [
        {
          id: "text-1",
          type: "text",
          text: "Before citation [citation:missing]",
        },
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
      ],
    );
  });
});
