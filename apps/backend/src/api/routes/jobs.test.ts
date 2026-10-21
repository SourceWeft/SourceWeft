import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentError } from "../../modules/content/errors";
import { ApiResponse, toApiError } from "../response/api-response";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  getJob: vi.fn(),
  stopRunForJob: vi.fn(),
}));
vi.mock("../middleware/auth-session", () => ({
  requireSession: mocks.session,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../../shared/config", () => ({ config: {} }));
vi.mock("../../shared/queue", () => ({
  deliverablesQueue: { getJob: vi.fn() },
  enqueueWithAudit: vi.fn(),
  jobsQueue: { add: vi.fn(), getJob: mocks.getJob },
}));
vi.mock("../../modules/threads", () => ({
  durableChatRunService: { stopRunForJob: mocks.stopRunForJob },
}));
import { registerJobRoutes } from "./jobs";

const CHAT_JOB_ID = "thread-chat-run_run-1";

function fakeJob(input: {
  id: string;
  name: string;
  state: string;
  userId?: string;
}) {
  return {
    id: input.id,
    name: input.name,
    data: {
      runId: "run-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: input.userId ?? "current-user",
    },
    getState: vi.fn().mockResolvedValue(input.state),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function cancel(jobId: string) {
  const app = new Hono();
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  registerJobRoutes(app);
  return app.request(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
}

describe("POST /v1/jobs/:id/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ user: { id: "current-user" } });
    mocks.stopRunForJob.mockResolvedValue({ id: "run-1", status: "cancelled" });
  });

  it("stops an active chat run through the durable stop instead of BullMQ", async () => {
    const job = fakeJob({
      id: CHAT_JOB_ID,
      name: "thread-chat-run",
      state: "active",
    });
    mocks.getJob.mockResolvedValue(job);

    const response = await cancel(CHAT_JOB_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: CHAT_JOB_ID, removed: true });
    expect(mocks.stopRunForJob).toHaveBeenCalledExactlyOnceWith({
      jobId: CHAT_JOB_ID,
      userId: "current-user",
    });
    expect(job.remove).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "waiting"])(
    "is idempotent for a chat run whose job is %s",
    async (state) => {
      const job = fakeJob({ id: CHAT_JOB_ID, name: "thread-chat-run", state });
      mocks.getJob.mockResolvedValue(job);
      mocks.stopRunForJob.mockResolvedValue({
        id: "run-1",
        status: "completed",
      });

      const first = await cancel(CHAT_JOB_ID);
      const second = await cancel(CHAT_JOB_ID);

      for (const response of [first, second]) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          id: CHAT_JOB_ID,
          removed: true,
        });
      }
      expect(mocks.stopRunForJob).toHaveBeenCalledTimes(2);
      expect(job.remove).not.toHaveBeenCalled();
    },
  );

  it("still stops an owned chat run whose finished job was evicted from the queue", async () => {
    mocks.getJob.mockResolvedValue(undefined);

    const response = await cancel(CHAT_JOB_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: CHAT_JOB_ID, removed: true });
    expect(mocks.stopRunForJob).toHaveBeenCalledExactlyOnceWith({
      jobId: CHAT_JOB_ID,
      userId: "current-user",
    });
  });

  it("hides a chat-run job whose data names another user", async () => {
    mocks.getJob.mockResolvedValue(
      fakeJob({
        id: CHAT_JOB_ID,
        name: "thread-chat-run",
        state: "active",
        userId: "someone-else",
      }),
    );

    const response = await cancel(CHAT_JOB_ID);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "JOB_NOT_FOUND",
      message: "Job not found",
    });
    expect(mocks.stopRunForJob).not.toHaveBeenCalled();
  });

  it.each([
    ["the job exists", true, "CHAT_RUN_NOT_FOUND"],
    ["the job exists", true, "WORKSPACE_NOT_FOUND"],
    ["the job was evicted", false, "CHAT_RUN_NOT_FOUND"],
    ["the job was evicted", false, "WORKSPACE_NOT_FOUND"],
  ])(
    "reports a durable stop rejection as an unknown job when %s (%s)",
    async (_label, exists, code) => {
      mocks.getJob.mockResolvedValue(
        exists
          ? fakeJob({
              id: CHAT_JOB_ID,
              name: "thread-chat-run",
              state: "active",
            })
          : undefined,
      );
      mocks.stopRunForJob.mockRejectedValue(
        new ContentError(404, code, "Not found"),
      );

      const response = await cancel(CHAT_JOB_ID);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: "JOB_NOT_FOUND",
        message: "Job not found",
      });
      expect(mocks.stopRunForJob).toHaveBeenCalledExactlyOnceWith({
        jobId: CHAT_JOB_ID,
        userId: "current-user",
      });
    },
  );

  it("keeps queue semantics for a non-chat job whose id has the chat-run prefix", async () => {
    const waiting = fakeJob({
      id: CHAT_JOB_ID,
      name: "example",
      state: "waiting",
    });
    mocks.getJob.mockResolvedValue(waiting);

    const removed = await cancel(CHAT_JOB_ID);

    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ id: CHAT_JOB_ID, removed: true });
    expect(waiting.remove).toHaveBeenCalledOnce();

    const active = fakeJob({
      id: CHAT_JOB_ID,
      name: "example",
      state: "active",
    });
    mocks.getJob.mockResolvedValue(active);

    const refused = await cancel(CHAT_JOB_ID);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "JOB_RUNNING" });
    expect(active.remove).not.toHaveBeenCalled();
    expect(mocks.stopRunForJob).not.toHaveBeenCalled();
  });

  it("surfaces a non-404 durable stop failure instead of reporting success", async () => {
    mocks.getJob.mockResolvedValue(
      fakeJob({ id: CHAT_JOB_ID, name: "thread-chat-run", state: "active" }),
    );
    mocks.stopRunForJob.mockRejectedValue(new Error("redis unavailable"));

    const response = await cancel(CHAT_JOB_ID);

    expect(response.status).toBe(500);
  });

  it("keeps an unknown non-chat job id a 404 without touching chat runs", async () => {
    mocks.getJob.mockResolvedValue(undefined);

    const response = await cancel("12345");

    expect(response.status).toBe(404);
    expect(mocks.stopRunForJob).not.toHaveBeenCalled();
  });

  it("keeps refusing to cancel an active non-chat job", async () => {
    const job = fakeJob({ id: "42", name: "example", state: "active" });
    mocks.getJob.mockResolvedValue(job);

    const response = await cancel("42");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "JOB_RUNNING" });
    expect(job.remove).not.toHaveBeenCalled();
    expect(mocks.stopRunForJob).not.toHaveBeenCalled();
  });

  it("still removes a waiting non-chat job from the queue", async () => {
    const job = fakeJob({ id: "43", name: "example", state: "waiting" });
    mocks.getJob.mockResolvedValue(job);

    const response = await cancel("43");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "43", removed: true });
    expect(job.remove).toHaveBeenCalledOnce();
    expect(mocks.stopRunForJob).not.toHaveBeenCalled();
  });

  it("hides a foreign non-chat job", async () => {
    const job = fakeJob({
      id: "44",
      name: "example",
      state: "waiting",
      userId: "someone-else",
    });
    mocks.getJob.mockResolvedValue(job);

    const response = await cancel("44");

    expect(response.status).toBe(404);
    expect(job.remove).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    mocks.session.mockResolvedValue(null);

    const response = await cancel(CHAT_JOB_ID);

    expect(response.status).toBe(401);
    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mocks.stopRunForJob).not.toHaveBeenCalled();
  });
});
