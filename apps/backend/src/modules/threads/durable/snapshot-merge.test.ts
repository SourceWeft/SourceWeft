import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_SNAPSHOT_REASONING_CHARS } from "./reasoning-bounds";
import { testExports } from "./runner";
import {
  mergeChatRunSnapshot,
  mergeCommittedArtifactRenderBlocks,
  readSnapshotRetrieval,
  resolveTerminalStatusFromFinishedSnapshot,
  slimSnapshotAssistantMessage,
  updateExistingTracePartsFromToolCalls,
} from "./snapshot";
import type { ChatRunSnapshot } from "./types";

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

test("reasoning base survives restart snapshots and rejects re-capture from partial output", () => {
  const reasoningRun = { runId: "run", parentRunId: "prior", base: "before" };
  const current = { reasoningRun, reasoning: "after", reasoningRevision: 5 };
  const merged = mergeChatRunSnapshot({
    current,
    incoming: { reasoning: "a", reasoningRevision: 1 },
  });
  assert.deepEqual(merged.reasoningRun, reasoningRun);
  assert.equal(merged.reasoning, "after");
  assert.equal(merged.reasoningRevision, 5);
  assert.throws(
    () =>
      mergeChatRunSnapshot({
        current,
        incoming: { reasoningRun: { ...reasoningRun, base: "before\nafter" } },
      }),
    /cannot change its reasoning base/,
  );
});

test("an over-long reasoning stays bounded through the snapshot merge", () => {
  const reasoningRun = { runId: "run", parentRunId: null, base: "" };
  let incoming: ChatRunSnapshot = { reasoningRun, reasoningRevision: 0 };
  const delta = "0123456789abcdef"; // 16 chars
  const deltas = 20_000; // 320,000 chars > MAX_SNAPSHOT_REASONING_CHARS
  for (let index = 0; index < deltas; index++) {
    incoming = testExports.updateSnapshotFromPayload(incoming, {
      type: "reasoning",
      reasoning: delta,
      segment: {
        id: `model-reasoning-${Math.floor(index / 5_000) + 1}`,
        sequence: Math.floor(index / 5_000) + 1,
        phase: "initial",
      },
    });
  }
  assert.ok(incoming.reasoning);
  assert.ok(incoming.reasoning.length <= MAX_SNAPSHOT_REASONING_CHARS);
  assert.match(
    incoming.reasoning,
    /^…\[reasoning truncated: \d+ chars dropped\]/u,
  );

  const merged = mergeChatRunSnapshot({
    current: { reasoningRun, reasoning: "older", reasoningRevision: 3 },
    incoming,
  });
  assert.equal(merged.reasoning, incoming.reasoning);
  assert.equal(merged.reasoningRevision, deltas);
  assert.ok(merged.reasoning!.length <= MAX_SNAPSHOT_REASONING_CHARS);
  assert.equal(merged.traceEvents?.length, 4);

  // A stale, unbounded copy at a lower revision cannot resurrect the longer text.
  const stale = mergeChatRunSnapshot({
    current: merged,
    incoming: {
      reasoningRun,
      reasoning: delta.repeat(deltas),
      reasoningRevision: deltas - 1,
    },
  });
  assert.equal(stale.reasoning, incoming.reasoning);
  assert.equal(stale.reasoningRevision, deltas);
});

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

  // Legacy embedded metadata still counts as committed-artifact authority, but
  // the copy itself is no longer written back into the slim embedded message.
  assert.deepEqual(merged.renderBlocks, [committedBlock]);
  assert.equal(merged.assistantMessage?.content, "done");
  assert.equal("renderBlocks" in merged.assistantMessage!.metadata, false);
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

test("a turn parked on the user is not a finished snapshot", () => {
  // The backstop that completes runs whose worker died judges a run by the
  // snapshot it inherited, and a resume run inherits the parked turn's
  // snapshot — finish reason included. Reading either pause reason as terminal
  // completed the resume run a third of a second after creating it, before its
  // worker had run a step: the SSE stream saw a terminal run, synthesized
  // `finish`, and the browser stopped listening while the worker went on to
  // write the real answer.
  for (const finishReason of [
    "user_question_requested",
    "tool_confirmation_requested",
  ]) {
    assert.equal(
      resolveTerminalStatusFromFinishedSnapshot({
        assistantMessage: {
          metadata: { finishReason },
        },
      } as never),
      null,
      `${finishReason} must not read as terminal`,
    );
  }
});

test("a genuinely finished snapshot still resolves terminal", () => {
  assert.equal(
    resolveTerminalStatusFromFinishedSnapshot({
      assistantMessage: { metadata: { finishReason: "stop" } },
    } as never),
    "completed",
  );
  assert.equal(
    resolveTerminalStatusFromFinishedSnapshot({
      assistantMessage: { metadata: { finishReason: "stop" } },
      errorCode: "CHAT_RUN_FAILED",
    } as never),
    "failed",
  );
});

test("refreshing existing tool trace parts from tool calls keeps them output-free", () => {
  const traceParts = [
    {
      id: "publish-1",
      kind: "tool",
      order: 0,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
      toolCallId: "publish-1",
      tool: "publish_artifact",
      input: { title: "Deck" },
      status: "running",
      latencyMs: null,
      error: null,
    },
  ];
  const refreshed = updateExistingTracePartsFromToolCalls(traceParts, [
    {
      id: "publish-1",
      tool: "publish_artifact",
      input: { title: "Deck" },
      output: { type: "committed_artifact_result", body: "x".repeat(50_000) },
      status: "completed",
      latencyMs: 42,
      error: null,
      sequence: 1,
      approvalState: "approved",
      approvalConfirmationId: "confirmation-1",
    },
    {
      id: "unknown-tool",
      tool: "search_sources",
      input: {},
      output: "ignored",
      status: "completed",
      latencyMs: null,
      error: null,
      sequence: 2,
    },
  ]);
  assert.ok(refreshed);
  assert.equal(refreshed.length, 1);
  const part = refreshed[0]!;
  assert.equal(part.kind, "tool");
  assert.ok(!("output" in part));
  assert.ok(!("input" in part));
  assert.ok(JSON.stringify(refreshed).length < 1024);
  assert.deepEqual(
    part.kind === "tool"
      ? {
          status: part.status,
          latencyMs: part.latencyMs,
          approvalState: part.approvalState,
          approvalConfirmationId: part.approvalConfirmationId,
          order: part.order,
        }
      : null,
    {
      status: "completed",
      latencyMs: 42,
      approvalState: "approved",
      approvalConfirmationId: "confirmation-1",
      order: 0,
    },
  );
});

test("a pre-reset snapshot at a lower revision cannot overwrite the post-reset shorter reasoning", () => {
  const reasoningRun = { runId: "run", parentRunId: null, base: "" };
  let snapshot: ChatRunSnapshot = { reasoningRun, reasoningRevision: 0 };
  const stream = (segmentId: string, sequence: number, deltas: string[]) => {
    for (const delta of deltas) {
      snapshot = testExports.updateSnapshotFromPayload(snapshot, {
        type: "reasoning",
        reasoning: delta,
        segment: { id: segmentId, sequence, phase: "initial" },
      });
    }
  };
  stream("model-reasoning-A", 1, ["long ", "failed ", "attempt"]);
  const preReset = snapshot;
  assert.equal(preReset.reasoning, "long failed attempt");

  snapshot = testExports.updateSnapshotFromPayload(snapshot, {
    type: "segment-reset",
    reason: "model_call_retry",
    attempt: 2,
    segmentIds: ["model-reasoning-A"],
    toolCallIds: [],
    keepTextChars: 0,
    dropReasoningChars: "long failed attempt".length,
    keepReasoningChars: 0,
  });
  stream("model-reasoning-B", 2, ["short"]);
  const postReset = snapshot;
  assert.equal(postReset.reasoning, "short");
  assert.ok(postReset.reasoningRevision! > preReset.reasoningRevision!);

  // A stale flush carrying the failed attempt's text loses to the reset.
  const merged = mergeChatRunSnapshot({
    current: postReset,
    incoming: preReset,
  });
  assert.equal(merged.reasoning, "short");
  assert.equal(merged.reasoningRevision, postReset.reasoningRevision);
  assert.deepEqual(
    (merged.reasoningSegments as Array<{ id: string }>).map((s) => s.id),
    ["model-reasoning-B"],
  );

  // The reverse direction (reset applied over the stale copy) wins as usual.
  const forward = mergeChatRunSnapshot({
    current: preReset,
    incoming: postReset,
  });
  assert.equal(forward.reasoning, "short");
});

const committedToolCall = {
  id: "publish-1",
  tool: "publish_artifact",
  input: { title: "Deck" },
  status: "completed",
  latencyMs: 10,
  error: null,
  sequence: 1,
  output: {
    status: "ready",
    type: "committed_artifact_result",
    artifactType: "slides",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    artifactOutputBlockId: committedBlock.id,
    workflowVersion: "v1",
  },
};

function fullAssistantMessage(metadata: Record<string, unknown>) {
  return {
    id: "message-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    parentMessageId: "user-message-1",
    role: "assistant" as const,
    content: "final answer",
    createdBy: null,
    model: "gpt-5",
    creditsConsumed: 7,
    contentJson: { version: 1, parts: [] },
    metadata,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
}

const finalizedMetadata = {
  finishReason: "stop",
  errorCode: null,
  traceId: "trace-1",
  userMessageId: "user-message-1",
  threadRun: { id: "run-1", status: "running" },
  agentRunStop: { reason: "step_limit" },
  toolCalls: [committedToolCall],
  renderBlocks: [committedBlock],
  traceParts: [{ id: "publish-1", kind: "tool" }],
  traceEvents: [{ id: "event-1" }],
  reasoning: "long reasoning",
  reasoningSegments: [{ id: "segment-1", text: "long reasoning" }],
  retrieval: { citations: [{ id: "c1" }], availableCitations: [{ id: "c1" }] },
  meteredLlmCalls: [{ id: "call-1", consumedCredits: 7 }],
  meteredLlmCreditsConsumed: 7,
  providerCostUsd: 0.01,
  modelAlias: "gpt-5",
};

const slimAssistantMessage = {
  id: "message-1",
  threadId: "thread-1",
  role: "assistant",
  parentMessageId: "user-message-1",
  content: "final answer",
  contentJson: { version: 1, parts: [] },
  model: "gpt-5",
  createdAt: "2026-10-21T00:00:00.000Z",
  metadata: {
    finishReason: "stop",
    errorCode: null,
    traceId: "trace-1",
    userMessageId: "user-message-1",
    threadRun: { id: "run-1", status: "running" },
    agentRunStop: { reason: "step_limit" },
  },
};

test("the merged snapshot persists only the slim assistant message", () => {
  const merged = mergeChatRunSnapshot({
    current: {},
    incoming: {
      toolCalls: [committedToolCall],
      renderBlocks: [committedBlock],
      assistantMessage: fullAssistantMessage(finalizedMetadata),
    },
  });

  assert.deepEqual(merged.assistantMessage, slimAssistantMessage);
  assert.deepEqual(
    slimSnapshotAssistantMessage(fullAssistantMessage(finalizedMetadata)),
    slimAssistantMessage,
  );
  assert.deepEqual(merged.toolCalls, [committedToolCall]);
  assert.deepEqual(merged.renderBlocks, [committedBlock]);
});

test("a row written with the full embedded copy shrinks on its next write", () => {
  const merged = mergeChatRunSnapshot({
    current: {
      toolCalls: [committedToolCall],
      renderBlocks: [committedBlock],
      assistantMessage: fullAssistantMessage(finalizedMetadata),
    },
    incoming: { lastEventType: "finish" },
  });

  assert.deepEqual(merged.assistantMessage, slimAssistantMessage);
  assert.equal(merged.lastEventType, "finish");
});

test("committed artifacts held only in a legacy embedded copy survive the slim merge", () => {
  // A row from before the slim copy whose top level lost the committed
  // publication (stale runner write) while the embedded metadata kept it.
  const merged = mergeChatRunSnapshot({
    current: {
      toolCalls: [],
      renderBlocks: [],
      assistantMessage: fullAssistantMessage({
        toolCalls: [committedToolCall],
        renderBlocks: [committedBlock],
      }),
    },
    incoming: {
      toolCalls: [{ ...committedToolCall, output: { stale: true } }],
      renderBlocks: [{ id: "text-1", type: "text", text: "stale" }],
    },
  });

  assert.deepEqual(merged.renderBlocks, [
    { id: "text-1", type: "text", text: "stale" },
    committedBlock,
  ]);
  assert.deepEqual(
    (merged.toolCalls as Array<{ output?: unknown }>)[0]?.output,
    committedToolCall.output,
  );
  assert.equal("toolCalls" in merged.assistantMessage!.metadata, false);
  assert.equal("renderBlocks" in merged.assistantMessage!.metadata, false);
});

test("the stale backstop still sees finishReason between finalize and finishRun", () => {
  // Between the finalizer's commit and finishRun, the finish reason exists only
  // on the embedded assistant message of the persisted snapshot.
  const persisted = mergeChatRunSnapshot({
    current: {},
    incoming: {
      assistantMessage: fullAssistantMessage({
        ...finalizedMetadata,
        errorCode: undefined,
      }),
    },
  });
  assert.equal(persisted.finishReason, undefined);
  assert.equal(persisted.assistantMessage?.metadata.finishReason, "stop");
  assert.equal(
    resolveTerminalStatusFromFinishedSnapshot(
      JSON.parse(JSON.stringify(persisted)) as ChatRunSnapshot,
    ),
    "completed",
  );
});

test("citations events write one retrieval location and keep its profile fields", () => {
  const registry = [{ id: "c1" }, { id: "c2" }];
  let snapshot = testExports.updateSnapshotFromPayload(
    {},
    { type: "citations", citations: registry },
  );
  assert.deepEqual(snapshot.retrieval, {
    citations: registry,
    availableCitations: registry,
  });
  assert.equal("citations" in snapshot, false);
  assert.equal("availableCitations" in snapshot, false);

  snapshot = {
    ...snapshot,
    retrieval: {
      embeddingProfileId: "profile-1",
      vectorStrategy: "ann_hnsw",
      annIndexUsed: "idx",
      citations: [],
      availableCitations: registry,
    },
  };
  snapshot = testExports.updateSnapshotFromPayload(snapshot, {
    type: "citations",
    citations: [{ id: "c2" }],
    availableCitations: registry,
  });
  assert.deepEqual(snapshot.retrieval, {
    embeddingProfileId: "profile-1",
    vectorStrategy: "ann_hnsw",
    annIndexUsed: "idx",
    citations: [{ id: "c2" }],
    availableCitations: registry,
  });
  assert.equal("citations" in snapshot, false);
});

test("retrieval reads fall back to top-level citations of older rows", () => {
  assert.equal(readSnapshotRetrieval({}), undefined);
  assert.deepEqual(readSnapshotRetrieval({ citations: [{ id: "c1" }] }), {
    citations: [{ id: "c1" }],
    availableCitations: [{ id: "c1" }],
  });
  assert.deepEqual(
    readSnapshotRetrieval({
      citations: [{ id: "c1" }],
      availableCitations: [{ id: "c1" }, { id: "c2" }],
    }),
    {
      citations: [{ id: "c1" }],
      availableCitations: [{ id: "c1" }, { id: "c2" }],
    },
  );
  // The single location wins over a stale legacy copy.
  assert.deepEqual(
    readSnapshotRetrieval({
      citations: [{ id: "stale" }],
      availableCitations: [{ id: "stale" }],
      retrieval: {
        embeddingProfileId: "profile-1",
        citations: [],
        availableCitations: [{ id: "c1" }],
      },
    }),
    {
      embeddingProfileId: "profile-1",
      citations: [],
      availableCitations: [{ id: "c1" }],
    },
  );
});
