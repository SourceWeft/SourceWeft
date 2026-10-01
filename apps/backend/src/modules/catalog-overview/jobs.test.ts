import type { Job } from "bullmq";
import { beforeEach, expect, test, vi } from "vitest";

const queue = vi.hoisted(() => ({ enqueue: vi.fn(), getJob: vi.fn() }));
vi.mock("../../shared/queue", () => ({
  enqueueWithAudit: queue.enqueue,
  jobsQueue: { getJob: queue.getJob },
}));

import { createOverviewJobs, enqueueOverviewBatch } from "./jobs";

/** The durable job side of the engine, for a fake kind. */

const store = {
  read: vi.fn(),
  request: vi.fn(),
  fail: vi.fn(),
  findInterrupted: vi.fn(),
};

const jobs = createOverviewJobs(
  {
    name: "thing-overview",
    versionKey: "thingVersionId",
    parentKey: "thingId",
    attempts: 3,
    backoffMs: 1_000,
    scopePrefix: "thing",
    label: "Thing",
  },
  store,
);

function job(data: Record<string, unknown>, attemptsMade = 0) {
  return {
    id: "job-1",
    data,
    attemptsMade,
    opts: { attempts: 3 },
    updateData: vi.fn(async () => undefined),
  } as unknown as Job<Record<string, unknown>> & {
    updateData: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queue.enqueue.mockResolvedValue({ id: "queued" });
  queue.getJob.mockResolvedValue(null);
  store.findInterrupted.mockResolvedValue([]);
});

test("each request gets its own deduplicating job id with bounded retries", async () => {
  store.request
    .mockResolvedValueOnce({ requestId: "one", status: "pending", force: true })
    .mockResolvedValueOnce({
      requestId: "two",
      status: "pending",
      force: true,
    });
  const payload = {
    thingVersionId: "v",
    thingId: "t",
    reason: "regenerate" as const,
  };
  await jobs.enqueue(payload);
  await jobs.enqueue(payload);
  expect(store.request).toHaveBeenCalledWith("v", true);
  expect(queue.enqueue.mock.calls.map((call) => call[2].jobId)).toEqual([
    "thing-overview_v_one",
    "thing-overview_v_two",
  ]);
  expect(queue.enqueue.mock.calls[0]![0]).toBe("thing-overview");
  expect(queue.enqueue.mock.calls[0]![1]).toEqual({
    ...payload,
    requestId: "one",
  });
  expect(queue.enqueue.mock.calls[0]![2]).toMatchObject({
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    // Behind tenant work: jobs with no priority are taken first.
    priority: 10,
    removeOnComplete: true,
  });
  expect(jobs.jobId("v")).toBe("thing-overview_v");
});

test("nothing is queued for a finished version or a superseded request", async () => {
  store.request.mockResolvedValue(null);
  expect(
    await jobs.enqueue({
      thingVersionId: "v",
      thingId: "t",
      reason: "scheduled",
    }),
  ).toBeNull();
  store.read.mockResolvedValue({ requestId: "newer", status: "pending" });
  expect(
    await jobs.enqueue({
      thingVersionId: "v",
      thingId: "t",
      reason: "scheduled",
      requestId: "older",
    }),
  ).toBeNull();
  store.read.mockResolvedValue({ requestId: "older", status: "ready" });
  expect(
    await jobs.enqueue({
      thingVersionId: "v",
      thingId: "t",
      reason: "scheduled",
      requestId: "older",
    }),
  ).toBeNull();
  expect(queue.enqueue).not.toHaveBeenCalled();
});

test("a queue failure is recorded on the request, for good", async () => {
  store.request.mockResolvedValue({ requestId: "one", status: "pending" });
  queue.enqueue.mockRejectedValueOnce(new Error("redis unavailable"));
  await expect(
    jobs.enqueue({ thingVersionId: "v", thingId: "t", reason: "scheduled" }),
  ).rejects.toThrow("redis unavailable");
  expect(store.fail).toHaveBeenCalledWith(
    "v",
    "one",
    expect.any(String),
    false,
  );
});

test("recovery re-queues an interrupted request under its own id; a failed job fails it", async () => {
  store.findInterrupted.mockResolvedValue([
    { versionId: "v", parentId: "t", requestId: "one", force: true },
  ]);
  store.read.mockResolvedValue({ requestId: "one", status: "pending" });
  expect(await jobs.recover()).toBe(1);
  expect(queue.getJob).toHaveBeenCalledWith("thing-overview_v_one");
  expect(store.request).not.toHaveBeenCalled();
  expect(queue.enqueue.mock.calls[0]![1]).toEqual({
    thingVersionId: "v",
    thingId: "t",
    requestId: "one",
    reason: "regenerate",
  });

  vi.clearAllMocks();
  store.findInterrupted.mockResolvedValue([
    { versionId: "v", parentId: "t", requestId: "one", force: false },
  ]);
  queue.getJob.mockResolvedValue({ getState: async () => "failed" });
  expect(await jobs.recover()).toBe(0);
  expect(store.fail).toHaveBeenCalledWith(
    "v",
    "one",
    expect.any(String),
    false,
  );
  expect(queue.enqueue).not.toHaveBeenCalled();
});

test("a thrown try stays pending for a retry, and fails for good on the last one", async () => {
  const run = vi.fn(async () => {
    throw new Error("model timeout");
  });
  const payload = {
    thingVersionId: "v",
    thingId: "t",
    reason: "scheduled",
    requestId: "one",
  };
  await expect(jobs.process(job(payload, 0), run)).rejects.toThrow(
    "model timeout",
  );
  expect(run).toHaveBeenCalledWith({
    versionId: "v",
    requestId: "one",
    force: false,
    scopeId: "thing:job-1:1",
  });
  expect(store.fail).toHaveBeenLastCalledWith(
    "v",
    "one",
    expect.any(String),
    true,
  );
  await expect(jobs.process(job(payload, 1), run)).rejects.toThrow();
  expect(store.fail).toHaveBeenLastCalledWith(
    "v",
    "one",
    expect.any(String),
    true,
  );
  await expect(jobs.process(job(payload, 2), run)).rejects.toThrow();
  expect(store.fail).toHaveBeenLastCalledWith(
    "v",
    "one",
    expect.any(String),
    false,
  );
  expect(store.fail).toHaveBeenCalledTimes(3);
});

test("a skip fails the request for good, unless it was already generated", async () => {
  const payload = {
    thingVersionId: "v",
    thingId: "t",
    reason: "regenerate",
    requestId: "one",
  };
  const skipped = vi.fn(async (_input: { force: boolean }) => ({
    status: "skipped" as const,
    reason: "not-eligible" as const,
  }));
  expect(await jobs.process(job(payload), skipped)).toEqual({
    status: "skipped",
    reason: "not-eligible",
  });
  expect(skipped.mock.calls[0]![0]).toMatchObject({ force: true });
  expect(store.fail).toHaveBeenCalledWith("v", "one", "not-eligible", false);

  store.fail.mockClear();
  await jobs.process(
    job(payload),
    vi.fn(async () => ({
      status: "skipped" as const,
      reason: "already-generated" as const,
    })),
  );
  expect(store.fail).not.toHaveBeenCalled();

  await jobs.process(
    job(payload),
    vi.fn(async () => ({ status: "generated" as const, model: "m" })),
  );
  expect(store.fail).not.toHaveBeenCalled();
});

test("a job without a request reserves one and records it on the job", async () => {
  store.request.mockResolvedValue({ requestId: "fresh", status: "pending" });
  const run = vi.fn(async (_input: { requestId: string }) => ({
    status: "generated" as const,
    model: "m",
  }));
  const queued = job({
    thingVersionId: "v",
    thingId: "t",
    reason: "scheduled",
  });
  await jobs.process(queued, run);
  expect(store.request).toHaveBeenCalledWith("v", false);
  expect(queued.updateData).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: "fresh" }),
  );
  expect(run.mock.calls[0]![0]).toMatchObject({ requestId: "fresh" });

  store.request.mockResolvedValue(null);
  const done = vi.fn();
  expect(
    await jobs.process(
      job({ thingVersionId: "v", thingId: "t", reason: "scheduled" }),
      done,
    ),
  ).toEqual({ status: "skipped", reason: "already-generated" });
  expect(done).not.toHaveBeenCalled();

  await expect(
    jobs.process(job({ thingId: "t", reason: "scheduled" }), done),
  ).rejects.toThrow("thing-overview job has no thingVersionId");
});

test("the batch waits for the system model, skips versions with a job, and stops at the cap", async () => {
  const candidates = Array.from({ length: 6 }, (_, i) => ({
    versionId: `v${i}`,
    payload: { id: i },
  }));
  const deps = {
    readModelReadiness: vi.fn(async () => ({ ready: false, reason: "off" })),
    recover: vi.fn(async () => 0),
    findCandidates: vi.fn(async () => candidates),
    jobExists: vi.fn(async (id: string) => id === "thing-overview_v1"),
    enqueue: vi.fn(async (_payload: unknown) => undefined),
  };
  const options = {
    jobId: jobs.jobId,
    batchSize: 3,
    scanLimit: 50,
    label: "Thing",
  };
  expect(await enqueueOverviewBatch(deps, options)).toEqual({
    queued: 0,
    skipped: 0,
  });
  expect(deps.recover).not.toHaveBeenCalled();
  expect(deps.findCandidates).not.toHaveBeenCalled();

  deps.readModelReadiness.mockResolvedValue({ ready: true, reason: "" });
  expect(await enqueueOverviewBatch(deps, options)).toEqual({
    queued: 3,
    skipped: 1,
  });
  expect(deps.recover).toHaveBeenCalledTimes(1);
  expect(deps.findCandidates).toHaveBeenCalledWith(50);
  expect(deps.enqueue.mock.calls.map((call) => call[0])).toEqual([
    { id: 0 },
    { id: 2 },
    { id: 3 },
  ]);
});
