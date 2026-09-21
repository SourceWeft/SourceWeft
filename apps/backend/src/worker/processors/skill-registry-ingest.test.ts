import assert from "node:assert/strict";
import { UnrecoverableError } from "bullmq";
import { beforeEach, test, vi } from "vitest";

/**
 * What the queue sees of an ingest run: which failures it may retry, which end
 * the job at once, and what the boundary does with a job that died on its own.
 */

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  failIfInFlight: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../../modules/skills/registry/ingest/pipeline", () => ({
  runIngestPipeline: mocks.runPipeline,
}));
vi.mock("../../modules/skills/registry/ingest/repository", () => ({
  failSubmissionIfInFlight: mocks.failIfInFlight,
}));
vi.mock("../../modules/skills/registry/ingest/queue", () => ({
  enqueueSkillIngestJob: mocks.enqueue,
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GitHubArchiveError } from "../../modules/market/parser/github-zip";
import { ContentError } from "../../modules/content/errors";
import { RegistrySubmissionError } from "../../modules/skills/registry/errors";
import { IngestSupersededError } from "../../modules/skills/registry/ingest/errors";
import {
  handleSkillIngestJobFailure,
  processSkillRegistryIngestJob,
  SKILL_INGEST_JOB_DEADLINE_MS,
  SKILL_INGEST_WORKER_CONCURRENCY,
} from "./skill-registry-ingest";

const job = (attemptsMade = 0, attempts = 3) => ({
  data: { submissionId: "sub_1" },
  attemptsMade,
  opts: { attempts },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.failIfInFlight.mockResolvedValue(true);
});

test("the budget is fixed in code: two at a time, ten minutes each", () => {
  assert.equal(SKILL_INGEST_WORKER_CONCURRENCY, 2);
  assert.equal(SKILL_INGEST_JOB_DEADLINE_MS, 600_000);
});

test("the pipeline is told whether a transient failure will be retried", async () => {
  mocks.runPipeline.mockResolvedValue({ status: "succeeded" });
  await processSkillRegistryIngestJob(job(0));
  await processSkillRegistryIngestJob(job(1));
  await processSkillRegistryIngestJob(job(2));
  assert.deepEqual(
    mocks.runPipeline.mock.calls.map((call) => call[0].willRetryTransient),
    [true, true, false],
  );
  assert.equal(mocks.runPipeline.mock.calls[0]?.[0].submissionId, "sub_1");
  assert.ok(mocks.runPipeline.mock.calls[0]?.[0].signal instanceof AbortSignal);
});

test("deterministic failures end the job at once", async () => {
  const deterministic = [
    new RegistrySubmissionError("REGISTRY_SUBMISSION_NOT_SKILL", "no skill"),
    new RegistrySubmissionError("REGISTRY_SUBMISSION_TOO_LARGE", "too large"),
    new RegistrySubmissionError("REGISTRY_SUBMISSION_UNPINNED", "unpinned"),
    new RegistrySubmissionError("REGISTRY_SUBMISSION_CONFLICT", "conflict"),
    new RegistrySubmissionError("REGISTRY_SUBMISSION_DEADLINE", "deadline"),
    new GitHubArchiveError("ARCHIVE_UNAVAILABLE", "GitHub zipball download failed 404"),
    new ContentError(404, "SKILL_NOT_FOUND", "nope"),
  ];
  for (const error of deterministic) {
    mocks.runPipeline.mockRejectedValueOnce(error);
    await assert.rejects(
      processSkillRegistryIngestJob(job()),
      (thrown) =>
        thrown instanceof UnrecoverableError &&
        thrown.message.includes(error.message),
      error.message,
    );
  }
});

test("transient failures are rethrown untouched so the queue backs off and retries", async () => {
  const transient = [
    new TypeError("fetch failed"),
    new GitHubArchiveError("ARCHIVE_TIMEOUT", "GitHub did not respond"),
    new GitHubArchiveError("ARCHIVE_UNAVAILABLE", "GitHub zipball download failed 502"),
    new GitHubArchiveError("ARCHIVE_UNAVAILABLE", "GitHub zipball download failed 429"),
    new RegistrySubmissionError("REGISTRY_SUBMISSION_TIMEOUT", "slow"),
    new Error("connection terminated unexpectedly"),
  ];
  for (const error of transient) {
    mocks.runPipeline.mockRejectedValueOnce(error);
    await assert.rejects(
      processSkillRegistryIngestJob(job()),
      (thrown) => thrown === error && !(thrown instanceof UnrecoverableError),
      error.message,
    );
  }
});

test("a superseded run completes quietly instead of failing the job", async () => {
  mocks.runPipeline.mockRejectedValue(new IngestSupersededError("sub_1"));
  assert.deepEqual(await processSkillRegistryIngestJob(job()), {
    status: "skipped",
    submissionId: "sub_1",
  });
});

test("a job without a submission id cannot be retried into sense", async () => {
  await assert.rejects(
    processSkillRegistryIngestJob({ data: {}, attemptsMade: 0, opts: {} }),
    UnrecoverableError,
  );
  assert.equal(mocks.runPipeline.mock.calls.length, 0);
});

test("the boundary closes the submission of a job that finally failed", async () => {
  const result = await handleSkillIngestJobFailure({
    data: { submissionId: "sub_1" },
    error: new Error("job stalled more than allowable limit"),
    getState: async () => "failed",
  });
  assert.equal(result, "marked");
  assert.deepEqual(mocks.failIfInFlight.mock.calls[0], [
    "sub_1",
    {
      code: "SKILL_INGEST_JOB_FAILED",
      message: "job stalled more than allowable limit",
    },
  ]);
});

test("the boundary leaves a job the queue is about to retry alone", async () => {
  const result = await handleSkillIngestJobFailure({
    data: { submissionId: "sub_1" },
    error: new Error("fetch failed"),
    getState: async () => "delayed",
  });
  assert.equal(result, "skipped");
  assert.equal(mocks.failIfInFlight.mock.calls.length, 0);
});

test("the boundary never overwrites what the processor recorded, and never throws", async () => {
  mocks.failIfInFlight.mockResolvedValueOnce(false);
  assert.equal(
    await handleSkillIngestJobFailure({
      data: { submissionId: "sub_1" },
      error: new Error("x"),
      getState: async () => "failed",
    }),
    "skipped",
  );
  mocks.failIfInFlight.mockRejectedValueOnce(new Error("db down"));
  assert.equal(
    await handleSkillIngestJobFailure({
      data: { submissionId: "sub_1" },
      error: new Error("x"),
      getState: async () => "failed",
    }),
    "skipped",
  );
  assert.equal(
    await handleSkillIngestJobFailure({
      data: {},
      error: new Error("x"),
      getState: async () => "failed",
    }),
    "skipped",
  );
});

test("a run deferred by GitHub's rate limit is queued again for when it lifts", async () => {
  const resumeAt = new Date(Date.now() + 45 * 60_000);
  const submission = {
    id: "sub_1",
    teamId: "team_1",
    workspaceId: "ws_1",
    attempts: 1,
  };
  mocks.runPipeline.mockResolvedValue({
    status: "deferred",
    submissionId: "sub_1",
    resumeAt,
    submission,
  });
  mocks.enqueue.mockResolvedValue({});
  // The job itself completes: no BullMQ retry spent on a limit with hours
  // to run.
  const outcome = await processSkillRegistryIngestJob(job(0));
  assert.equal(outcome.status, "deferred");
  assert.deepEqual(mocks.enqueue.mock.calls, [
    [submission, { notBefore: resumeAt }],
  ]);

  // Could not reach the queue: the job fails as transient, so BullMQ tries
  // again (and the row is still `queued`).
  mocks.enqueue.mockRejectedValueOnce(new Error("redis down"));
  await assert.rejects(
    processSkillRegistryIngestJob(job(0)),
    (thrown) => !(thrown instanceof UnrecoverableError),
  );
});
