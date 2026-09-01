import assert from "node:assert/strict";
import { test } from "vitest";
import { createMessageRenderBlockBuilder } from "../../turn/render-blocks";
import {
  publishArtifactAndRecordOutput,
  recordPublishedArtifactOutput,
} from "./host-services";

test("records multiple main and sub-agent publications on one chat run", () => {
  const renderBlocks = createMessageRenderBlockBuilder();
  const runtime = { renderBlocks };

  recordPublishedArtifactOutput({
    origin: {
      producer: { kind: "main" },
      sourceToolCallId: "publish-main",
      threadRunId: "run-1",
    },
    result: { artifactId: "artifact-1", versionId: "version-1" },
    runtime,
  });
  recordPublishedArtifactOutput({
    origin: {
      producer: { kind: "subagent", subagentType: "general-purpose" },
      sourceToolCallId: "publish-child",
      threadRunId: "run-1",
    },
    result: { artifactId: "artifact-2", versionId: "version-1" },
    runtime,
  });
  recordPublishedArtifactOutput({
    origin: {
      producer: { kind: "main" },
      sourceToolCallId: "retry",
      threadRunId: "run-1",
    },
    result: { artifactId: "artifact-1", versionId: "version-1" },
    runtime,
  });

  assert.equal(renderBlocks.list().length, 2);
  assert.deepEqual(
    renderBlocks.list().map((block) =>
      block.type === "artifact_output"
        ? {
            artifactId: block.artifactId,
            producer: block.producer,
            sequence: block.sequence,
          }
        : null,
    ),
    [
      { artifactId: "artifact-1", producer: { kind: "main" }, sequence: 1 },
      {
        artifactId: "artifact-2",
        producer: { kind: "subagent", subagentType: "general-purpose" },
        sequence: 2,
      },
    ],
  );
});

test("an aborted publisher cannot append an artifact output card", async () => {
  const renderBlocks = createMessageRenderBlockBuilder();
  const controller = new AbortController();
  const abortReason = new DOMException("tool timeout", "TimeoutError");
  controller.abort(abortReason);

  await assert.rejects(
    publishArtifactAndRecordOutput({
      origin: {
        producer: { kind: "main" },
        sourceToolCallId: "publish-aborted",
        threadRunId: "run-1",
      },
      publish: async (input) => {
        assert.equal(input.signal, controller.signal);
        throw input.signal?.reason;
      },
      publishInput: {
        context: {
          teamId: "team-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          userId: "user-1",
        },
        signal: controller.signal,
        spec: {
          artifactType: "image",
          title: "Aborted image",
          payload: {},
        },
      },
      runtime: { renderBlocks },
    }),
    (error: unknown) => error === abortReason,
  );

  assert.deepEqual(renderBlocks.list(), []);
});
