import assert from "node:assert/strict";
import { test } from "vitest";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import {
  finishRunIfSnapshotIsTerminalWithDependencies,
  hasCommittedArtifactPublication,
} from "./run-recovery";
import type { ChatRunSnapshot, ChatThreadRunRecord } from "./types";

const recoveryPublisher = defineAgentTool({
  id: "recoveryCommittedPublisher",
  name: "recovery_committed_publisher",
  domain: "artifact",
  capabilities: ["artifact"],
  activation: {
    default: "off",
    userControl: "none",
    skill: { declarable: false, activates: false },
  },
  executionScope: "root_only",
  terminalResult: {
    kind: "committed_artifact",
    artifactType: "test_artifact",
  },
});
registerAgentTools([recoveryPublisher]);

const run: ChatThreadRunRecord = {
  id: "run-1",
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "user-1",
  userMessageId: "user-message-1",
  assistantMessageId: "assistant-1",
  idempotencyKey: "run-key",
  mode: "send",
  jobId: "job-1",
  streamKey: "stream-1",
  status: "running",
  eventOffset: 1,
  requestJson: {},
  snapshotJson: {},
  errorCode: null,
  errorMessage: null,
  startedAt: "2026-08-28T00:00:00.000Z",
  heartbeatAt: "2026-08-28T00:00:00.000Z",
  finishedAt: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

function committedSnapshot(): ChatRunSnapshot {
  const blockId = "artifact-output:run-1:artifact-1:version-1";
  return {
    toolCalls: [
      {
        id: "publish-call",
        tool: recoveryPublisher.name,
        input: {},
        output: {
          status: "ready",
          type: "committed_artifact_result",
          artifactType: "test_artifact",
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
          artifactOutputBlockId: blockId,
          workflowVersion: "test-v2",
        },
        status: "completed",
        latencyMs: null,
        error: null,
        sequence: 1,
        producer: { kind: "main" },
      },
    ],
    renderBlocks: [
      {
        id: blockId,
        type: "artifact_output",
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        threadRunId: "run-1",
        sourceToolCallId: "publish-call",
        placement: "terminal",
        producer: { kind: "main" },
        sequence: 1,
      },
    ],
  };
}

test("paired registered committed publication is a recoverable terminal fact", () => {
  assert.equal(
    hasCommittedArtifactPublication(committedSnapshot(), run.id),
    true,
  );
  const forged = committedSnapshot();
  (
    forged.renderBlocks as Array<Record<string, unknown>>
  )[0]!.artifactVersionId = "forged-version";
  assert.equal(hasCommittedArtifactPublication(forged, run.id), false);
});

test("stale recovery completes a run whose atomic publisher already committed", async () => {
  const snapshot = committedSnapshot();
  const active = { ...run, snapshotJson: snapshot };
  const finishCalls: unknown[] = [];
  const completed = { ...active, status: "completed" as const };

  const result = await finishRunIfSnapshotIsTerminalWithDependencies(active, {
    finishRun: (async (input: unknown) => {
      finishCalls.push(input);
      return completed;
    }) as never,
    findRunById: (async () => completed) as never,
    updateAssistantMetadata: (async () => null) as never,
  });

  assert.equal(result.status, "completed");
  assert.equal(finishCalls.length, 1);
});
