import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import { db, threads, workspaces } from "@sourceweft/db";
import { AGENT_TOOL_HOST_LIMITS } from "@sourceweft/contracts/agent-tools";
import {
  createProtectedRunOperationCacheServices,
  createProtectedRunReceiptServices,
} from "./protected-agent-tool-state-repository";
import {
  createChatThreadRun,
  findChatThreadRunById,
  finishChatThreadRun,
  markChatThreadRunRunning,
} from "./repository";
import {
  canonicalProtectedJson,
  readProtectedAgentToolState,
} from "./protected-agent-tool-state";
import type { ChatRunSnapshot } from "./types";

let teamId: string;
let workspaceId: string;
let threadId: string;
let runId: string;

beforeEach(async () => {
  teamId = randomUUID();
  workspaceId = randomUUID();
  threadId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Protected Agent tool state test",
    slug: `protected-agent-tool-${workspaceId}`,
  });
  await db.insert(threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Protected Agent tool state test",
  });
  const run = await createChatThreadRun({
    teamId,
    workspaceId,
    threadId,
    userId: "user-1",
    idempotencyKey: `protected-state:${randomUUID()}`,
    mode: "send",
    requestJson: {
      mode: "send",
      workspaceId,
      threadId,
      userId: "user-1",
      content: "test protected state",
    },
  });
  assert.ok(run);
  runId = run.id;
  await markChatThreadRunRunning({ runId, teamId, workspaceId });
});

afterEach(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
});

function scope() {
  return { runId, teamId, workspaceId };
}

function operationService() {
  return createProtectedRunOperationCacheServices({
    scope: scope(),
    maxOperations: 32,
    assertRootToolCall: () => undefined,
  });
}

test("receipts are deterministic and survive outside model-visible messages", async () => {
  const receipts = createProtectedRunReceiptServices({
    scope: scope(),
    assertRootToolCall: () => undefined,
  });
  const input = {
    producerToolName: "validate_fixture",
    producerToolCallId: "validation-call-1",
    schemaVersion: "validation-receipt",
    payload: { passed: true, digest: "abc" },
  } as const;

  const first = await receipts.issueCurrentRunReceipt(input);
  const second = await receipts.issueCurrentRunReceipt(input);
  const resolved = await receipts.resolveCurrentRunReceipt({
    receiptId: first.receiptId,
    producerToolName: input.producerToolName,
    executionScope: "root_only",
  });

  assert.equal(first.receiptId, second.receiptId);
  assert.deepEqual(resolved, input.payload);
  const run = await findChatThreadRunById({ runId, teamId, workspaceId });
  assert.ok(run?.snapshotJson.protectedAgentTools);
  assert.equal(run?.snapshotJson.renderBlocks, undefined);
});

test("receipt resolution rejects an unexpected schema version", async () => {
  const receipts = createProtectedRunReceiptServices({
    scope: scope(),
    assertRootToolCall: () => undefined,
  });
  const issued = await receipts.issueCurrentRunReceipt({
    producerToolName: "validate_fixture",
    producerToolCallId: "validation-call-schema",
    schemaVersion: "validation-receipt",
    payload: { passed: true, digest: "sha256:validated" },
  });

  const matching = await receipts.resolveCurrentRunReceipt({
    receiptId: issued.receiptId,
    producerToolName: "validate_fixture",
    expectedSchemaVersion: "validation-receipt",
    executionScope: "root_only",
  });
  const mismatched = await receipts.resolveCurrentRunReceipt({
    receiptId: issued.receiptId,
    producerToolName: "validate_fixture",
    expectedSchemaVersion: "different-receipt",
    executionScope: "root_only",
  });

  assert.deepEqual(matching, { passed: true, digest: "sha256:validated" });
  assert.equal(mismatched, null);
});

test("the maximum video workload fits the operation and protected JSON ceilings", async () => {
  assert.equal(AGENT_TOOL_HOST_LIMITS.operationClaimMaxKeys, 256);
  const service = createProtectedRunOperationCacheServices({
    scope: scope(),
    maxOperations: AGENT_TOOL_HOST_LIMITS.operationClaimMaxKeys,
    assertRootToolCall: () => undefined,
  });
  const workload = [
    ...Array.from({ length: 4 }, (_, batch) => ({
      toolName: "generate_video_assets",
      toolCallId: `asset-batch-${batch + 1}`,
      semanticKeys: Array.from(
        { length: 12 },
        (_, index) => `asset:${batch * 12 + index + 1}`,
      ),
    })),
    {
      toolName: "generate_video_narration",
      toolCallId: "narration-batch-1",
      semanticKeys: Array.from(
        { length: 12 },
        (_, index) => `narration:${index + 1}`,
      ),
    },
    {
      toolName: "load_video_presentation",
      toolCallId: "load-call-1",
      semanticKeys: ["load:current-version"],
    },
    {
      toolName: "validate_video_presentation",
      toolCallId: "validation-call-1",
      semanticKeys: ["validation:closure"],
    },
    {
      toolName: "publish_video_presentation",
      toolCallId: "publication-call-1",
      semanticKeys: ["publication:receipt"],
    },
  ];
  const claimed: Array<{
    claimToken: string;
    semanticKey: string;
    toolName: string;
  }> = [];

  for (const group of workload) {
    const result = await service.claimMany({
      ...group,
      executionScope: "root_only",
    });
    assert.equal(result.kind, "claimed");
    if (result.kind !== "claimed") {
      assert.fail("Expected the fresh worst-case workload to be claimed");
    }
    for (const item of result.items) {
      assert.equal(item.action, "execute");
      if (item.action !== "execute") {
        assert.fail("Fresh worst-case workload unexpectedly reused an item");
      }
      claimed.push({
        claimToken: item.claimToken,
        semanticKey: item.semanticKey,
        toolName: group.toolName,
      });
    }
  }

  assert.equal(claimed.length, 48 + 12 + 3);
  for (const [index, item] of claimed.entries()) {
    await service.complete({
      ...item,
      observation: {
        status: "succeeded",
        digest: `sha256:${index.toString(16).padStart(64, "0")}`,
      },
    });
  }

  const run = await findChatThreadRunById({ runId, teamId, workspaceId });
  assert.ok(run);
  const state = readProtectedAgentToolState({
    snapshot: run.snapshotJson as ChatRunSnapshot,
    scope: scope(),
  });
  assert.equal(Object.keys(state.semanticOperations).length, 63);
  assert.ok(
    Object.values(state.semanticOperations).every(
      (operation) => operation.status === "completed",
    ),
  );
  assert.ok(
    Buffer.byteLength(canonicalProtectedJson(state), "utf8") <=
      AGENT_TOOL_HOST_LIMITS.protectedJsonMaxBytes,
  );
});

test("concurrent same-key claims execute once and make the follower wait", async () => {
  const first = operationService();
  const second = operationService();
  const claim = (
    service: ReturnType<typeof operationService>,
    toolCallId: string,
  ) =>
    service.claimMany({
      toolName: "generate_video_assets",
      toolCallId,
      semanticKeys: ["asset:cover"],
      executionScope: "root_only",
    });

  const results = await Promise.all([
    claim(first, "asset-call-a"),
    claim(second, "asset-call-b"),
  ]);

  assert.equal(results.filter((result) => result.kind === "claimed").length, 1);
  assert.equal(results.filter((result) => result.kind === "wait").length, 1);
});

test("the same tool-call replay waits instead of executing the side effect twice", async () => {
  const service = operationService();
  const input = {
    toolName: "generate_video_assets",
    toolCallId: "same-owner",
    semanticKeys: ["asset:cover"],
    executionScope: "root_only" as const,
  };
  const first = await service.claimMany(input);
  const replay = await service.claimMany(input);

  assert.equal(first.kind, "claimed");
  assert.deepEqual(replay, { kind: "wait", ownerToolCallId: "same-owner" });
});

test("overlapping reverse-order batches never leave a loser partial claim", async () => {
  const service = operationService();
  const results = await Promise.all([
    service.claimMany({
      toolName: "generate_video_narration",
      toolCallId: "narration-a",
      semanticKeys: ["slide:a", "slide:b"],
      executionScope: "root_only",
    }),
    service.claimMany({
      toolName: "generate_video_narration",
      toolCallId: "narration-b",
      semanticKeys: ["slide:b", "slide:a"],
      executionScope: "root_only",
    }),
  ]);

  assert.equal(results.filter((result) => result.kind === "claimed").length, 1);
  assert.equal(results.filter((result) => result.kind === "wait").length, 1);
  const run = await findChatThreadRunById({ runId, teamId, workspaceId });
  assert.ok(run);
  const state = readProtectedAgentToolState({
    snapshot: run.snapshotJson as ChatRunSnapshot,
    scope: scope(),
  });
  assert.equal(Object.keys(state.semanticOperations).length, 2);
  const owners = new Set(
    Object.values(state.semanticOperations).map(
      (operation) => operation.ownerToolCallId,
    ),
  );
  assert.equal(owners.size, 1);
});

test("completed observations replay without another execute claim", async () => {
  const service = operationService();
  const claimed = await service.claimMany({
    toolName: "generate_video_narration",
    toolCallId: "narration-owner",
    semanticKeys: ["slide:1"],
    executionScope: "root_only",
  });
  assert.equal(claimed.kind, "claimed");
  const item = claimed.kind === "claimed" ? claimed.items[0] : null;
  assert.equal(item?.action, "execute");
  assert.ok(item && item.action === "execute");
  const completed = await service.complete({
    toolName: "generate_video_narration",
    semanticKey: "slide:1",
    claimToken: item.claimToken,
    observation: { blobRef: "opaque-ref", durationSeconds: 3.2 },
  });
  const replay = await service.claimMany({
    toolName: "generate_video_narration",
    toolCallId: "narration-follower",
    semanticKeys: ["slide:1"],
    executionScope: "root_only",
  });

  assert.ok(completed.observationId);
  assert.equal(replay.kind, "claimed");
  assert.equal(
    replay.kind === "claimed" ? replay.items[0]?.action : null,
    "reuse",
  );
});

test("unknown plus free batch returns unknown without a partial claim", async () => {
  const service = operationService();
  const claimed = await service.claimMany({
    toolName: "generate_video_assets",
    toolCallId: "unknown-owner",
    semanticKeys: ["asset:unknown"],
    executionScope: "root_only",
  });
  assert.equal(claimed.kind, "claimed");
  const item = claimed.kind === "claimed" ? claimed.items[0] : null;
  assert.ok(item && item.action === "execute");
  await service.markUnknown({
    toolName: "generate_video_assets",
    semanticKey: "asset:unknown",
    claimToken: item.claimToken,
    reason: "PROVIDER_OUTCOME_UNKNOWN",
  });

  const result = await service.claimMany({
    toolName: "generate_video_assets",
    toolCallId: "unknown-follower",
    semanticKeys: ["asset:new", "asset:unknown"],
    executionScope: "root_only",
  });
  assert.deepEqual(result, {
    kind: "unknown",
    code: "SIDE_EFFECT_OUTCOME_UNKNOWN",
  });
  const run = await findChatThreadRunById({ runId, teamId, workspaceId });
  assert.ok(run);
  const state = readProtectedAgentToolState({
    snapshot: run.snapshotJson as ChatRunSnapshot,
    scope: scope(),
  });
  assert.equal(Object.keys(state.semanticOperations).length, 1);
});

test("a stale claim token cannot complete another operation", async () => {
  const service = operationService();
  const claimed = await service.claimMany({
    toolName: "generate_video_assets",
    toolCallId: "token-owner",
    semanticKeys: ["asset:token"],
    executionScope: "root_only",
  });
  assert.equal(claimed.kind, "claimed");

  await assert.rejects(
    service.complete({
      toolName: "generate_video_assets",
      semanticKey: "asset:token",
      claimToken: randomUUID(),
      observation: { shouldNotPersist: true },
    }),
    /PROTECTED_AGENT_TOOL_CLAIM_FENCE_LOST/,
  );
});

test("terminalization fences in-progress claims unknown in the same run write", async () => {
  const service = operationService();
  const claimed = await service.claimMany({
    toolName: "generate_video_assets",
    toolCallId: "asset-owner",
    semanticKeys: ["asset:1"],
    executionScope: "root_only",
  });
  assert.equal(claimed.kind, "claimed");
  const item = claimed.kind === "claimed" ? claimed.items[0] : null;
  assert.ok(item && item.action === "execute");

  const finished = await finishChatThreadRun({
    runId,
    teamId,
    workspaceId,
    status: "failed",
    snapshotMode: "terminal_patch",
    protectedOperationTerminalReason: "RUN_OWNER_DIED",
    errorCode: "CHAT_RUN_STALE",
  });
  assert.equal(finished?.status, "failed");
  const state = readProtectedAgentToolState({
    snapshot: finished?.snapshotJson as ChatRunSnapshot,
    scope: scope(),
  });
  assert.equal(Object.values(state.semanticOperations)[0]?.status, "unknown");
  await assert.rejects(
    service.complete({
      toolName: "generate_video_assets",
      semanticKey: "asset:1",
      claimToken: item.claimToken,
      observation: { completedLate: true },
    }),
    /PROTECTED_AGENT_TOOL_RUN_NOT_ACTIVE/,
  );
});

test("complete versus terminal recovery leaves completed or unknown, never in progress", async () => {
  const service = operationService();
  const claimed = await service.claimMany({
    toolName: "generate_video_narration",
    toolCallId: "race-owner",
    semanticKeys: ["slide:race"],
    executionScope: "root_only",
  });
  assert.equal(claimed.kind, "claimed");
  const item = claimed.kind === "claimed" ? claimed.items[0] : null;
  assert.ok(item && item.action === "execute");

  await Promise.allSettled([
    service.complete({
      toolName: "generate_video_narration",
      semanticKey: "slide:race",
      claimToken: item.claimToken,
      observation: { blobRef: "race-blob" },
    }),
    finishChatThreadRun({
      runId,
      teamId,
      workspaceId,
      status: "failed",
      snapshotMode: "terminal_patch",
      protectedOperationTerminalReason: "RUN_OWNER_DIED",
      errorCode: "CHAT_RUN_STALE",
    }),
  ]);

  const run = await findChatThreadRunById({ runId, teamId, workspaceId });
  assert.ok(run);
  const state = readProtectedAgentToolState({
    snapshot: run.snapshotJson as ChatRunSnapshot,
    scope: scope(),
  });
  assert.ok(
    Object.values(state.semanticOperations).every(
      (operation) => operation.status !== "in_progress",
    ),
  );
});
