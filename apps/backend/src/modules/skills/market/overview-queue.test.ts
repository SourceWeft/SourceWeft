import { beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  request: vi.fn(),
  read: vi.fn(),
  fail: vi.fn(),
  interrupted: vi.fn(),
  enqueue: vi.fn(),
  job: vi.fn(),
}));
vi.mock("./analysis-repository", () => ({
  requestSkillAnalysis: mock.request,
  readSkillAnalysis: mock.read,
  failSkillAnalysis: mock.fail,
  findInterruptedSkillAnalyses: mock.interrupted,
}));
vi.mock("../../../shared/queue", () => ({
  enqueueWithAudit: mock.enqueue,
  jobsQueue: { getJob: mock.job },
}));
import {
  enqueueSkillOverviewJob,
  recoverSkillOverviewJobs,
} from "./overview-queue";
beforeEach(() => {
  vi.clearAllMocks();
  mock.enqueue.mockResolvedValue({ id: "job" });
  mock.interrupted.mockResolvedValue([]);
  mock.job.mockResolvedValue(null);
});
test("regenerations have unique request IDs even in the same millisecond", async () => {
  mock.request
    .mockResolvedValueOnce({ requestId: "one" })
    .mockResolvedValueOnce({ requestId: "two" });
  const payload = {
    skillId: "s",
    skillVersionId: "v",
    reason: "regenerate" as const,
  };
  await enqueueSkillOverviewJob(payload);
  await enqueueSkillOverviewJob(payload);
  expect(mock.enqueue.mock.calls.map((call) => call[2].jobId)).toEqual([
    "skill-overview-generate_v_one",
    "skill-overview-generate_v_two",
  ]);
});
test("enqueue failure becomes a visible durable failure", async () => {
  mock.request.mockResolvedValue({ requestId: "one" });
  mock.enqueue.mockRejectedValueOnce(new Error("redis unavailable"));
  await expect(
    enqueueSkillOverviewJob({
      skillId: "s",
      skillVersionId: "v",
      reason: "scheduled",
    }),
  ).rejects.toThrow("redis unavailable");
  expect(mock.fail).toHaveBeenCalledWith("v", "one", expect.any(String), false);
});
test("recovery reuses reserved request ID without superseding a newer generation", async () => {
  mock.interrupted.mockResolvedValue([
    { skillId: "s", skillVersionId: "v", requestId: "one", force: true },
  ]);
  mock.read.mockResolvedValue({ requestId: "one", status: "pending" });
  expect(await recoverSkillOverviewJobs()).toBe(1);
  expect(mock.request).not.toHaveBeenCalled();
  expect(mock.enqueue.mock.calls[0]![1]).toMatchObject({
    requestId: "one",
    reason: "regenerate",
  });
  mock.read.mockResolvedValue({ requestId: "newer", status: "pending" });
  expect(await recoverSkillOverviewJobs()).toBe(0);
});
test("recovery reports terminal worker failures rather than retrying forever", async () => {
  mock.interrupted.mockResolvedValue([
    { skillId: "s", skillVersionId: "v", requestId: "one", force: false },
  ]);
  mock.job.mockResolvedValue({ getState: async () => "failed" });
  expect(await recoverSkillOverviewJobs()).toBe(0);
  expect(mock.fail).toHaveBeenCalledWith("v", "one", expect.any(String), false);
  expect(mock.enqueue).not.toHaveBeenCalled();
});
