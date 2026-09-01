import assert from "node:assert/strict";
import { test } from "vitest";
import {
  mergeChatRunSnapshot,
  mergeCommittedArtifactRenderBlocks,
} from "./snapshot";

const committedBlock = {
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  id: "artifact-output:run-1:artifact-1:version-1",
  placement: "terminal",
  producer: { kind: "main" },
  sequence: 2,
  sourceToolCallId: "publish-1",
  threadRunId: "run-1",
  type: "artifact_output",
};

test("stale runner render blocks cannot remove a committed artifact output", () => {
  const merged = mergeChatRunSnapshot({
    current: {
      assistantContent: "old",
      renderBlocks: [
        { id: "tool-old", type: "tool", toolCallId: "tool-old" },
        committedBlock,
      ],
    },
    incoming: {
      assistantContent: "new",
      renderBlocks: [{ id: "tool-new", type: "tool", toolCallId: "tool-new" }],
    },
  });

  assert.equal(merged.assistantContent, "new");
  assert.deepEqual(merged.renderBlocks, [
    { id: "tool-new", type: "tool", toolCallId: "tool-new" },
    committedBlock,
  ]);
});

test("authoritative committed block wins a conflicting stale block id", () => {
  const staleConflict = {
    ...committedBlock,
    artifactVersionId: "tampered-version",
  };
  const merged = mergeCommittedArtifactRenderBlocks({
    incoming: [staleConflict, staleConflict],
    authoritative: [[committedBlock]],
  });

  assert.deepEqual(merged, [committedBlock]);
});

test("conflicting authoritative committed identities fail closed", () => {
  assert.throws(
    () =>
      mergeCommittedArtifactRenderBlocks({
        incoming: [],
        authoritative: [
          [committedBlock],
          [
            {
              ...committedBlock,
              artifactVersionId: "different-authoritative-version",
            },
          ],
        ],
      }),
    /ARTIFACT_OUTPUT_AUTHORITY_CONFLICT/,
  );
});

test("assistant metadata repairs a run snapshot missing its committed block", () => {
  const merged = mergeChatRunSnapshot({
    current: { renderBlocks: [] },
    incoming: { renderBlocks: [] },
    assistantMessageMetadata: {
      renderBlocks: [committedBlock],
    },
  });

  assert.deepEqual(merged.renderBlocks, [committedBlock]);
});

test("nested assistant metadata also preserves committed blocks", () => {
  const merged = mergeChatRunSnapshot({
    current: {
      assistantMessage: {
        id: "message-1",
        teamId: "team-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        parentMessageId: null,
        role: "assistant",
        content: "",
        createdBy: null,
        model: null,
        creditsConsumed: null,
        contentJson: {},
        metadata: { renderBlocks: [committedBlock] },
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    },
    incoming: {
      assistantMessage: {
        id: "message-1",
        teamId: "team-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        parentMessageId: null,
        role: "assistant",
        content: "done",
        createdBy: null,
        model: null,
        creditsConsumed: null,
        contentJson: {},
        metadata: { renderBlocks: [] },
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    },
  });

  assert.deepEqual(merged.renderBlocks, [committedBlock]);
  assert.deepEqual(merged.assistantMessage?.metadata.renderBlocks, [
    committedBlock,
  ]);
});

test("runner snapshots cannot overwrite host-only Agent tool state", () => {
  const protectedAgentTools = {
    version: 1,
    trustedReceipts: { receipt_1: { schemaVersion: "validation-v1" } },
  };
  const merged = mergeChatRunSnapshot({
    current: { protectedAgentTools },
    incoming: {
      assistantContent: "safe update",
      protectedAgentTools: { forged: true },
    },
  });

  assert.equal(merged.assistantContent, "safe update");
  assert.deepEqual(merged.protectedAgentTools, protectedAgentTools);
});
