import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentError } from "../../content/errors";
import type { ChatThreadRunRecord } from "./types";

const mocks = vi.hoisted(() => ({
  requireContentWorkspace: vi.fn(),
  findChatThreadRunById: vi.fn(),
  findChatThreadRunByIdempotencyKey: vi.fn(),
  requestChatThreadRunCancel: vi.fn(),
  forceCancelStoppedRun: vi.fn(),
  appendStop: vi.fn(),
  publishCancel: vi.fn(),
}));

vi.mock("../../workspace/guards", () => ({
  requireContentWorkspace: mocks.requireContentWorkspace,
}));
vi.mock("./repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository")>()),
  findChatThreadRunById: mocks.findChatThreadRunById,
  findChatThreadRunByIdempotencyKey: mocks.findChatThreadRunByIdempotencyKey,
  requestChatThreadRunCancel: mocks.requestChatThreadRunCancel,
}));
vi.mock("./run-recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-recovery")>()),
  forceCancelStoppedRun: mocks.forceCancelStoppedRun,
}));
vi.mock("./stream-manager", () => ({
  chatRunStreamManager: {
    appendStop: mocks.appendStop,
    publishCancel: mocks.publishCancel,
  },
}));

import { durableChatRunService } from "./service";

const JOB_ID = "thread-chat-run_run-1";

function createRun(
  input: Partial<ChatThreadRunRecord> = {},
): ChatThreadRunRecord {
  const now = new Date(0).toISOString();
  return {
    id: "run-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    userMessageId: "user-message-1",
    assistantMessageId: "assistant-message-1",
    idempotencyKey: "sourceweft-web-run:key-1",
    mode: "send",
    jobId: JOB_ID,
    streamKey: "chat-run-events:run-1",
    status: "running",
    eventOffset: 0,
    requestJson: {},
    snapshotJson: {},
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    heartbeatAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

async function expectNotFound(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContentError);
  expect((error as ContentError).statusCode).toBe(404);
}

describe("durableChatRunService.stopRunForJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireContentWorkspace.mockResolvedValue({
      id: "workspace-1",
      organizationId: "team-1",
    });
  });

  it("fences the job's run through the stream stop's ownership lookup", async () => {
    const run = createRun();
    const cancelRequested = createRun({ status: "cancel_requested" });
    const cancelled = createRun({ status: "cancelled" });
    mocks.findChatThreadRunById.mockResolvedValue(run);
    mocks.findChatThreadRunByIdempotencyKey.mockResolvedValue(run);
    mocks.requestChatThreadRunCancel.mockResolvedValue(cancelRequested);
    mocks.forceCancelStoppedRun.mockResolvedValue(cancelled);

    const result = await durableChatRunService.stopRunForJob({
      jobId: JOB_ID,
      userId: "user-1",
    });

    expect(result).toBe(cancelled);
    expect(mocks.findChatThreadRunById).toHaveBeenCalledWith({
      runId: "run-1",
    });
    // Authorization is the stream stop's: workspace access for the caller,
    // then the run by its key inside that workspace — ids from the run row.
    expect(mocks.requireContentWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      idempotencyKey: "sourceweft-web-run:key-1",
    });
    expect(mocks.findChatThreadRunByIdempotencyKey).toHaveBeenCalledWith({
      teamId: "team-1",
      workspaceId: "workspace-1",
      idempotencyKey: "sourceweft-web-run:key-1",
    });
    expect(mocks.requestChatThreadRunCancel).toHaveBeenCalledWith({
      runId: "run-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
    });
    expect(mocks.appendStop).toHaveBeenCalledWith("chat-run-events:run-1");
    expect(mocks.publishCancel).toHaveBeenCalledWith("run-1");
    expect(mocks.forceCancelStoppedRun).toHaveBeenCalledWith(cancelRequested);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "returns an already %s run unchanged without writing a fence",
    async (status) => {
      const run = createRun({ status });
      mocks.findChatThreadRunById.mockResolvedValue(run);
      mocks.findChatThreadRunByIdempotencyKey.mockResolvedValue(run);

      const result = await durableChatRunService.stopRunForJob({
        jobId: JOB_ID,
        userId: "user-1",
      });

      expect(result).toBe(run);
      expect(mocks.requestChatThreadRunCancel).not.toHaveBeenCalled();
      expect(mocks.publishCancel).not.toHaveBeenCalled();
    },
  );

  it("returns the finished run when it completes between lookup and fence", async () => {
    const running = createRun();
    const completed = createRun({ status: "completed" });
    mocks.findChatThreadRunById.mockResolvedValue(running);
    mocks.findChatThreadRunByIdempotencyKey
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed);
    // The row is no longer stoppable when the cancel transaction locks it.
    mocks.requestChatThreadRunCancel.mockResolvedValue(null);

    const result = await durableChatRunService.stopRunForJob({
      jobId: JOB_ID,
      userId: "user-1",
    });

    expect(result).toBe(completed);
    expect(mocks.publishCancel).not.toHaveBeenCalled();
    expect(mocks.forceCancelStoppedRun).not.toHaveBeenCalled();
  });

  it("accepts a run whose job id is not yet recorded on the row", async () => {
    const run = createRun({ jobId: null, status: "completed" });
    mocks.findChatThreadRunById.mockResolvedValue(run);
    mocks.findChatThreadRunByIdempotencyKey.mockResolvedValue(run);

    await expect(
      durableChatRunService.stopRunForJob({ jobId: JOB_ID, userId: "user-1" }),
    ).resolves.toBe(run);
  });

  it("rejects another member's run before resolving its workspace", async () => {
    mocks.findChatThreadRunById.mockResolvedValue(createRun());

    await expectNotFound(
      durableChatRunService.stopRunForJob({
        jobId: JOB_ID,
        userId: "someone-else",
      }),
    );
    expect(mocks.requireContentWorkspace).not.toHaveBeenCalled();
    expect(mocks.requestChatThreadRunCancel).not.toHaveBeenCalled();
  });

  it("rejects the owner once they no longer have workspace access", async () => {
    mocks.findChatThreadRunById.mockResolvedValue(createRun());
    mocks.requireContentWorkspace.mockRejectedValue(
      new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found"),
    );

    await expectNotFound(
      durableChatRunService.stopRunForJob({ jobId: JOB_ID, userId: "user-1" }),
    );
    expect(mocks.requestChatThreadRunCancel).not.toHaveBeenCalled();
  });

  it("rejects a run the stream stop's lookup does not place on the same thread", async () => {
    mocks.findChatThreadRunById.mockResolvedValue(createRun());
    mocks.findChatThreadRunByIdempotencyKey.mockResolvedValue(
      createRun({ threadId: "other-thread" }),
    );

    await expectNotFound(
      durableChatRunService.stopRunForJob({ jobId: JOB_ID, userId: "user-1" }),
    );
    expect(mocks.requestChatThreadRunCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown run", JOB_ID, null],
    ["a non-chat job id", "12345", createRun()],
    ["a job id the run row does not carry", JOB_ID, createRun({ jobId: "x" })],
  ])("rejects %s", async (_label, jobId, run) => {
    mocks.findChatThreadRunById.mockResolvedValue(run);

    await expectNotFound(
      durableChatRunService.stopRunForJob({ jobId, userId: "user-1" }),
    );
    expect(mocks.requireContentWorkspace).not.toHaveBeenCalled();
    expect(mocks.requestChatThreadRunCancel).not.toHaveBeenCalled();
  });
});
