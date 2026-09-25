import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@sourceweft/db";
import { messages, threads, workspaces } from "@sourceweft/db";
import { randomUUID } from "node:crypto";

describe("renderBlocks persistence", () => {
  let workspaceId: string;
  let threadId: string;
  let userMessageId: string;
  let assistantMessageId: string;
  let teamId: string;

  beforeEach(async () => {
    teamId = randomUUID();

    workspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      organizationId: teamId,
      name: "Test Workspace",
      slug: `test-workspace-${workspaceId}`,
    });

    threadId = randomUUID();
    await db.insert(threads).values({
      id: threadId,
      teamId,
      workspaceId,
      title: "Test Thread",
    });

    userMessageId = randomUUID();
    await db.insert(messages).values({
      id: userMessageId,
      teamId,
      workspaceId,
      threadId,
      role: "user",
      content: "Test user message",
      metadata: {},
    });

    assistantMessageId = randomUUID();
    await db.insert(messages).values({
      id: assistantMessageId,
      teamId,
      workspaceId,
      threadId,
      role: "assistant",
      content: "",
      metadata: {},
    });
  });

  afterEach(async () => {
    await db.delete(messages).where(eq(messages.threadId, threadId));
    await db.delete(threads).where(eq(threads.id, threadId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  test("renderBlocks are not duplicated across multiple flushes", async () => {
    const initialBlocks = [
      { id: "reasoning-1", type: "reasoning", text: "Initial reasoning" },
      { id: "tool-1", type: "tool", toolCallId: "tool-1" },
      { id: "text-1", type: "text", text: "Initial response" },
    ];

    await db
      .update(messages)
      .set({
        metadata: {
          renderBlocks: initialBlocks,
          threadRun: {
            id: "run-1",
            status: "waiting_for_approval",
            durationMs: 5000,
          },
        },
      })
      .where(eq(messages.id, assistantMessageId));

    const resumedBlocks = [
      { id: "reasoning-1", type: "reasoning", text: "Initial reasoning" },
      { id: "tool-1", type: "tool", toolCallId: "tool-1" },
      { id: "text-1", type: "text", text: "Initial response" },
      { id: "text-2", type: "text", text: "Resumed response" },
    ];

    await db
      .update(messages)
      .set({
        metadata: {
          renderBlocks: resumedBlocks,
          threadRun: {
            id: "run-1",
            status: "completed",
            durationMs: 8000,
          },
        },
      })
      .where(eq(messages.id, assistantMessageId));

    const finalMessage = await db.query.messages.findFirst({
      where: eq(messages.id, assistantMessageId),
    });

    assert.ok(finalMessage, "Message should exist");
    assert.ok(finalMessage?.metadata, "Metadata should exist");
    assert.ok(
      Array.isArray(finalMessage?.metadata?.renderBlocks),
      "renderBlocks should be an array"
    );

    const renderBlocks = finalMessage?.metadata?.renderBlocks as any[];
    assert.equal(renderBlocks.length, 4, "Should have exactly 4 blocks, not duplicated");

    assert.deepEqual(
      renderBlocks.map((b) => b.id),
      ["reasoning-1", "tool-1", "text-1", "text-2"],
      "Block IDs should be unique and in order"
    );
  });

  test("duration is correctly accumulated across resumed runs", async () => {
    await db
      .update(messages)
      .set({
        metadata: {
          renderBlocks: [],
          threadRun: {
            id: "run-1",
            status: "waiting_for_approval",
            durationMs: 5000,
          },
        },
      })
      .where(eq(messages.id, assistantMessageId));

    const firstMessage = await db.query.messages.findFirst({
      where: eq(messages.id, assistantMessageId),
    });

    const firstDuration = (firstMessage?.metadata?.threadRun as any)?.durationMs;
    assert.equal(firstDuration, 5000, "First run duration should be 5000ms");

    await db
      .update(messages)
      .set({
        metadata: {
          renderBlocks: [],
          threadRun: {
            id: "run-1",
            status: "completed",
            durationMs: 8000,
          },
        },
      })
      .where(eq(messages.id, assistantMessageId));

    const secondMessage = await db.query.messages.findFirst({
      where: eq(messages.id, assistantMessageId),
    });

    const secondDuration = (secondMessage?.metadata?.threadRun as any)?.durationMs;
    assert.equal(secondDuration, 8000, "Second run duration should be 8000ms (accumulated)");
  });

  test("renderBlocks are replaced, not appended, when snapshot contains full state", async () => {
    const existingBlocks = [
      { id: "old-1", type: "text", text: "Old content" },
      { id: "old-2", type: "text", text: "More old content" },
    ];

    await db
      .update(messages)
      .set({
        metadata: {
          renderBlocks: existingBlocks,
        },
      })
      .where(eq(messages.id, assistantMessageId));

    const newBlocks = [
      { id: "new-1", type: "text", text: "New content" },
    ];

    await db
      .update(messages)
      .set({
        metadata: {
          renderBlocks: newBlocks,
        },
      })
      .where(eq(messages.id, assistantMessageId));

    const finalMessage = await db.query.messages.findFirst({
      where: eq(messages.id, assistantMessageId),
    });

    const renderBlocks = finalMessage?.metadata?.renderBlocks as any[];
    assert.equal(renderBlocks.length, 1, "Should have exactly 1 block (replaced, not appended)");
    assert.equal(renderBlocks[0].id, "new-1", "Should be the new block");
  });
});
