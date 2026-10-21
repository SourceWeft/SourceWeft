import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const findThreadRecordMock = vi.fn();
const findMessageRecordMock = vi.fn();

// Only the thread lookup is stubbed; the visibility decision (`canViewThread`)
// stays real so the test exercises the actual authorization rule.
vi.mock("../thread/repository", async (importActual) => {
  const actual = await importActual<typeof import("../thread/repository")>();
  return {
    ...actual,
    findThreadRecord: (input: unknown) => findThreadRecordMock(input),
  };
});

vi.mock("../message-repository", async (importActual) => {
  const actual = await importActual<typeof import("../message-repository")>();
  return {
    ...actual,
    findMessageRecord: (input: unknown) => findMessageRecordMock(input),
  };
});

const { isRunThreadViewable, getRunResult } = await import("./run-results");

const reasoningWrite = {
  runId: "run",
  parentRunId: "prior",
  base: "before",
  revision: 2,
  terminal: true,
};

test("completed API result retains reasoning but excludes its internal fixed base", async () => {
  findMessageRecordMock.mockResolvedValue(null);
  const metadata = {
    reasoning: "before\nafter",
    reasoningWrite: { ...reasoningWrite },
  };
  const run = {
    snapshotJson: {
      thread: { id: "thread" },
      userMessage: { id: "user" },
      assistantMessage: { id: "assistant", metadata },
    },
  } as unknown as Parameters<typeof getRunResult>[0];
  const result = await getRunResult(run);
  assert.equal(result.assistantMessage.metadata.reasoning, metadata.reasoning);
  assert.equal("reasoningWrite" in result.assistantMessage.metadata, false);
  assert.equal(metadata.reasoningWrite.base, "before");
});

test("the run result reads the assistant message from its row, not the slim snapshot copy", async () => {
  const rowMetadata = {
    finishReason: "stop",
    reasoning: "before\nafter",
    reasoningWrite: { ...reasoningWrite },
    meteredLlmCalls: [{ id: "call-1", consumedCredits: 3 }],
    toolCalls: [{ id: "tool-1", tool: "search", output: "found" }],
  };
  findMessageRecordMock.mockResolvedValue({
    id: "assistant",
    content: "final answer",
    metadata: rowMetadata,
  });
  const run = {
    teamId: "team-1",
    workspaceId: "workspace-1",
    assistantMessageId: "assistant",
    snapshotJson: {
      thread: { id: "thread" },
      userMessage: { id: "user" },
      assistantMessage: {
        id: "assistant",
        content: "partial",
        metadata: { finishReason: "stop" },
      },
      retrieval: {
        embeddingProfileId: "profile-1",
        vectorStrategy: "ann_hnsw",
        annIndexUsed: "idx",
        citations: [{ id: "c1" }],
        availableCitations: [{ id: "c1" }, { id: "c2" }],
      },
    },
  } as unknown as Parameters<typeof getRunResult>[0];
  const result = await getRunResult(run);
  assert.deepEqual(findMessageRecordMock.mock.lastCall?.[0], {
    teamId: "team-1",
    workspaceId: "workspace-1",
    messageId: "assistant",
  });
  assert.equal(result.assistantMessage.content, "final answer");
  assert.deepEqual(
    result.assistantMessage.metadata.meteredLlmCalls,
    rowMetadata.meteredLlmCalls,
  );
  assert.deepEqual(
    result.assistantMessage.metadata.toolCalls,
    rowMetadata.toolCalls,
  );
  assert.equal("reasoningWrite" in result.assistantMessage.metadata, false);
  assert.deepEqual(result.retrieval, {
    embeddingProfileId: "profile-1",
    vectorStrategy: "ann_hnsw",
    annIndexUsed: "idx",
    citations: [{ id: "c1" }],
    availableCitations: [{ id: "c1" }, { id: "c2" }],
  });
});

test("the run result still reads retrieval from rows written before the single location", async () => {
  findMessageRecordMock.mockResolvedValue({ id: "assistant", metadata: {} });
  const run = {
    assistantMessageId: "assistant",
    snapshotJson: {
      thread: { id: "thread" },
      userMessage: { id: "user" },
      citations: [{ id: "c1" }],
    },
  } as unknown as Parameters<typeof getRunResult>[0];
  const result = await getRunResult(run);
  assert.deepEqual(result.retrieval, {
    embeddingProfileId: null,
    vectorStrategy: null,
    annIndexUsed: null,
    citations: [{ id: "c1" }],
    availableCitations: [{ id: "c1" }],
  });
});

const context = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "viewer-1",
};

beforeEach(() => {
  findThreadRecordMock.mockReset();
});

test("run initiator may follow their own run without a thread lookup", async () => {
  const viewable = await isRunThreadViewable(context, { userId: "viewer-1" });

  assert.equal(viewable, true);
  assert.equal(findThreadRecordMock.mock.calls.length, 0);
});

test("another member may follow a run on a workspace-visible thread", async () => {
  findThreadRecordMock.mockResolvedValue({
    visibility: "workspace",
    createdBy: "owner-1",
  });

  const viewable = await isRunThreadViewable(context, { userId: "owner-1" });

  assert.equal(viewable, true);
});

test("another member may not follow a run on someone else's private thread", async () => {
  findThreadRecordMock.mockResolvedValue({
    visibility: "private",
    createdBy: "owner-1",
  });

  const viewable = await isRunThreadViewable(context, { userId: "owner-1" });

  assert.equal(viewable, false);
});

test("a missing thread is never viewable", async () => {
  findThreadRecordMock.mockResolvedValue(null);

  const viewable = await isRunThreadViewable(context, { userId: "owner-1" });

  assert.equal(viewable, false);
});
