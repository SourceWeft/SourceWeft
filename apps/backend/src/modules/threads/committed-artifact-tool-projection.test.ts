import assert from "node:assert/strict";
import { test } from "vitest";
import { mergeCommittedArtifactToolCalls } from "./render-block-projection";

function block(input?: { artifactId?: string; versionId?: string }) {
  return {
    artifactId: input?.artifactId ?? "artifact-1",
    artifactVersionId: input?.versionId ?? "version-1",
    id: `artifact-output:run-1:${input?.artifactId ?? "artifact-1"}:${input?.versionId ?? "version-1"}`,
    placement: "terminal",
    producer: { kind: "main" },
    sequence: 1,
    sourceToolCallId: "publish-1",
    threadRunId: "run-1",
    type: "artifact_output",
  };
}

function call(input?: { artifactId?: string; versionId?: string }) {
  const committedBlock = block(input);
  return {
    id: "publish-1",
    tool: "publish_video_presentation",
    input: {},
    output: {
      status: "ready",
      type: "committed_artifact_result",
      artifactType: "video_presentation",
      artifactId: committedBlock.artifactId,
      artifactVersionId: committedBlock.artifactVersionId,
      artifactOutputBlockId: committedBlock.id,
      workflowVersion: "video-presentation-agent",
    },
    status: "completed",
    latencyMs: null,
    error: null,
    sequence: 1,
  };
}

test("a committed result paired with its block survives a stale running call", () => {
  const committed = call();
  const merged = mergeCommittedArtifactToolCalls({
    incoming: [{ ...committed, output: null, status: "running" }],
    authoritative: [{ toolCalls: [committed], renderBlocks: [block()] }],
  });

  assert.deepEqual(merged, [committed]);
});

test("a forged committed-shaped result without its block receives no authority", () => {
  const forged = call();
  const stale = { ...forged, output: null, status: "running" };
  const merged = mergeCommittedArtifactToolCalls({
    incoming: [stale],
    authoritative: [{ toolCalls: [forged], renderBlocks: [] }],
  });

  assert.deepEqual(merged, [stale]);
});

test("two durable facts cannot commit different artifacts for one tool call", () => {
  assert.throws(
    () =>
      mergeCommittedArtifactToolCalls({
        incoming: [],
        authoritative: [
          { toolCalls: [call()], renderBlocks: [block()] },
          {
            toolCalls: [call({ artifactId: "artifact-2" })],
            renderBlocks: [block({ artifactId: "artifact-2" })],
          },
        ],
      }),
    /ARTIFACT_TOOL_OUTPUT_AUTHORITY_CONFLICT/u,
  );
});
