import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessageItem } from "../streaming-assistant-state";
import {
  findArtifactOutputMessage,
  mergeCommittedArtifactOutputsIntoMessage,
  mergeCommittedArtifactOutputsIntoMessages,
  mergeCommittedArtifactOutputsIntoStreamingSnapshot,
} from "./artifact-output-reconcile";

function message(input: {
  id: string;
  renderBlocks?: unknown[];
  runId?: string;
  toolCalls?: unknown[];
}): ChatMessageItem {
  return {
    id: input.id,
    role: "assistant",
    content: "local streaming text",
    contentJson: {},
    parentMessageId: null,
    metadata: {
      ...(input.renderBlocks ? { renderBlocks: input.renderBlocks } : {}),
      ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
      ...(input.runId ? { threadRun: { id: input.runId } } : {}),
    },
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

const artifactOutput = {
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  id: "artifact-output:run-1:artifact-1:version-1",
  placement: "terminal",
  producer: { kind: "main" },
  sequence: 1,
  sourceToolCallId: "tool-1",
  threadRunId: "run-1",
  type: "artifact_output",
};

const committedToolOutput = {
  status: "ready",
  type: "committed_artifact_result",
  artifactType: "video_presentation",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  artifactOutputBlockId: artifactOutput.id,
  workflowVersion: "video-presentation-agent",
};

const committedPublisherCall = {
  id: "tool-1",
  tool: "publish_video_presentation",
  input: { validationReceiptId: "receipt-1" },
  output: committedToolOutput,
  latencyMs: 42,
  status: "completed",
  error: null,
  sequence: 7,
};

test("finds the authoritative updated assistant by id or run receipt", () => {
  const authoritative = message({
    id: "assistant-1",
    renderBlocks: [artifactOutput],
  });
  assert.equal(
    findArtifactOutputMessage({
      messages: [authoritative],
      target: { assistantMessageId: "assistant-1", runId: "run-1" },
    }),
    authoritative,
  );
  assert.equal(
    findArtifactOutputMessage({
      messages: [authoritative],
      target: { runId: "run-1" },
    }),
    authoritative,
  );
});

test("merges committed output by stable id without replacing streaming blocks", () => {
  const authoritative = message({
    id: "assistant-1",
    renderBlocks: [artifactOutput, artifactOutput],
  });
  const localText = { id: "text-1", type: "text", text: "still streaming" };
  const localTool = { id: "tool-1", type: "tool", toolCallId: "tool-1" };
  const current = message({
    id: "temp-assistant",
    runId: "run-1",
    renderBlocks: [localText, localTool],
  });

  const once = mergeCommittedArtifactOutputsIntoMessages({
    authoritative,
    current: [current],
    target: { assistantMessageId: "assistant-1", runId: "run-1" },
  });
  const twice = mergeCommittedArtifactOutputsIntoMessages({
    authoritative,
    current: once,
    target: { assistantMessageId: "assistant-1", runId: "run-1" },
  });

  assert.deepEqual(twice[0]?.metadata.renderBlocks, [
    localText,
    localTool,
    artifactOutput,
  ]);
  assert.equal(twice[0]?.content, "local streaming text");
});

test("merges into the transient streaming snapshot and retains its aliases", () => {
  const authoritative = message({
    id: "assistant-1",
    renderBlocks: [artifactOutput],
  });
  const currentMessage = message({
    id: "temp-assistant",
    runId: "run-1",
    renderBlocks: [{ id: "text-1", type: "text", text: "live" }],
  });
  const merged = mergeCommittedArtifactOutputsIntoStreamingSnapshot({
    authoritative,
    current: {
      message: currentMessage,
      messageId: "temp-assistant",
      messageIds: ["temp-assistant"],
      renderVersion: 3,
    },
    target: { assistantMessageId: "assistant-1", runId: "run-1" },
  });

  assert.equal(merged?.renderVersion, 4);
  assert.deepEqual(merged?.messageIds, ["temp-assistant", "assistant-1"]);
  assert.equal(
    (merged?.message.metadata.renderBlocks as unknown[]).filter(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "artifact_output",
    ).length,
    1,
  );
});

test("presence REST repair converges a lost publication notify to completed tool and card", () => {
  // NotifyHub's artifact_output wake-up was lost. The existing room presence
  // heartbeat fetched this authoritative assistant row over REST while the
  // local stream still showed the publisher as running.
  const authoritative = message({
    id: "assistant-1",
    renderBlocks: [artifactOutput],
    toolCalls: [committedPublisherCall],
  });
  const unrelatedRunningCall = {
    id: "tool-2",
    tool: "read_file",
    input: { path: "/workspace/notes.md" },
    output: null,
    latencyMs: null,
    status: "running",
    error: null,
  };
  const local = message({
    id: "temp-assistant",
    runId: "run-1",
    renderBlocks: [{ id: "tool-block-1", type: "tool", toolCallId: "tool-1" }],
    toolCalls: [
      {
        ...committedPublisherCall,
        output: null,
        latencyMs: null,
        status: "running",
      },
      unrelatedRunningCall,
    ],
  });

  const messages = mergeCommittedArtifactOutputsIntoMessages({
    authoritative,
    current: [local],
    target: { assistantMessageId: "assistant-1", runId: "run-1" },
  });
  const messagesAfterNextHeartbeat = mergeCommittedArtifactOutputsIntoMessages({
    authoritative,
    current: messages,
    target: { assistantMessageId: "assistant-1", runId: "run-1" },
  });
  const snapshot = mergeCommittedArtifactOutputsIntoStreamingSnapshot({
    authoritative,
    current: {
      message: local,
      messageId: local.id,
      messageIds: [local.id],
      renderVersion: 9,
    },
    target: { assistantMessageId: "assistant-1", runId: "run-1" },
  });

  for (const reconciled of [messages[0], snapshot?.message]) {
    const toolCalls = reconciled?.metadata.toolCalls as Array<{
      id: string;
      output: unknown;
      status: string;
    }>;
    assert.equal(
      toolCalls.find((call) => call.id === "tool-1")?.status,
      "completed",
    );
    assert.deepEqual(
      toolCalls.find((call) => call.id === "tool-1")?.output,
      committedToolOutput,
    );
    assert.equal(
      toolCalls.find((call) => call.id === "tool-2")?.status,
      "running",
    );
    assert.equal(
      (reconciled?.metadata.renderBlocks as unknown[]).some(
        (block) =>
          block !== null &&
          typeof block === "object" &&
          (block as { id?: unknown }).id === artifactOutput.id,
      ),
      true,
    );
  }
  assert.equal(messages[0]?.id, "temp-assistant");
  assert.equal(messages[0]?.content, "local streaming text");
  assert.equal(snapshot?.renderVersion, 10);
  assert.equal(
    (
      messagesAfterNextHeartbeat[0]?.metadata.toolCalls as Array<{ id: string }>
    ).filter((call) => call.id === "tool-1").length,
    1,
  );
  assert.equal(
    (messagesAfterNextHeartbeat[0]?.metadata.renderBlocks as unknown[]).filter(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        (block as { id?: unknown }).id === artifactOutput.id,
    ).length,
    1,
  );
});

test("re-merging identical committed data is a no-op that preserves object identity", () => {
  // `authoritative` is refetched fresh on every reconcile (a new object every
  // call), so a naive reference check between it and `current` can never
  // detect "nothing changed". mergeCommittedArtifactOutputsIntoMessage must
  // compare values instead, so a repeated reconcile of already-committed data
  // (e.g. the 15s presence heartbeat) returns the exact `current` reference
  // rather than rebuilding the message (and, transitively, its containing
  // array/snapshot) for no reason.
  const authoritativeFirstFetch = message({
    id: "assistant-1",
    renderBlocks: [artifactOutput],
    toolCalls: [committedPublisherCall],
  });
  const local = message({
    id: "temp-assistant",
    runId: "run-1",
    toolCalls: [{ ...committedPublisherCall, output: null, status: "running" }],
  });

  const firstMerge = mergeCommittedArtifactOutputsIntoMessage({
    authoritative: authoritativeFirstFetch,
    current: local,
  });
  assert.notEqual(firstMerge, local);

  // A brand-new object with byte-for-byte identical content, standing in for
  // the next REST fetch's fresh (but unchanged) response.
  const authoritativeSecondFetch = message({
    id: "assistant-1",
    renderBlocks: [{ ...artifactOutput }],
    toolCalls: [{ ...committedPublisherCall }],
  });
  const secondMerge = mergeCommittedArtifactOutputsIntoMessage({
    authoritative: authoritativeSecondFetch,
    current: firstMerge,
  });

  assert.equal(secondMerge, firstMerge);

  // That identity preservation is what makes the array-level short-circuit in
  // mergeCommittedArtifactOutputsIntoMessages reachable.
  const messages = mergeCommittedArtifactOutputsIntoMessages({
    authoritative: authoritativeSecondFetch,
    current: [firstMerge],
    target: { assistantMessageId: "assistant-1", runId: "run-1" },
  });
  assert.equal(messages[0], firstMerge);
});

test("a genuinely changed committed field still rebuilds the message", () => {
  const authoritativeFirstFetch = message({
    id: "assistant-1",
    renderBlocks: [artifactOutput],
    toolCalls: [committedPublisherCall],
  });
  const local = message({
    id: "temp-assistant",
    runId: "run-1",
    toolCalls: [{ ...committedPublisherCall, output: null, status: "running" }],
  });
  const firstMerge = mergeCommittedArtifactOutputsIntoMessage({
    authoritative: authoritativeFirstFetch,
    current: local,
  });

  // A later fetch that legitimately changed one committed field (e.g. a
  // corrected title/receipt) must still be promoted.
  const authoritativeUpdatedFetch = message({
    id: "assistant-1",
    renderBlocks: [{ ...artifactOutput }],
    toolCalls: [{ ...committedPublisherCall, latencyMs: 999 }],
  });
  const secondMerge = mergeCommittedArtifactOutputsIntoMessage({
    authoritative: authoritativeUpdatedFetch,
    current: firstMerge,
  });

  assert.notEqual(secondMerge, firstMerge);
  assert.equal(
    (secondMerge.metadata.toolCalls as Array<{ latencyMs: number }>).find(
      (call) => call.latencyMs === 999,
    )?.latencyMs,
    999,
  );
});

test("REST repair does not promote an unpaired ready-shaped tool call", () => {
  const authoritative = message({
    id: "assistant-1",
    renderBlocks: [artifactOutput],
    toolCalls: [
      {
        ...committedPublisherCall,
        output: {
          ...committedToolOutput,
          artifactOutputBlockId: "different-block",
        },
      },
    ],
  });
  const local = message({
    id: "temp-assistant",
    runId: "run-1",
    toolCalls: [{ ...committedPublisherCall, output: null, status: "running" }],
  });

  const [reconciled] = mergeCommittedArtifactOutputsIntoMessages({
    authoritative,
    current: [local],
    target: { assistantMessageId: "assistant-1", runId: "run-1" },
  });

  assert.equal(
    (reconciled?.metadata.toolCalls as Array<{ status: string }>)[0]?.status,
    "running",
  );
});
