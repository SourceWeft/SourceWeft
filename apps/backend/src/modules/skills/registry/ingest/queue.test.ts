import { expect, test, vi } from "vitest";
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../../../../shared/config", () => ({
  config: { skillIngestQueueName: "test-skill-ingest" },
}));
vi.mock("../../../../shared/queue", () => ({
  enqueueWithAudit: enqueue,
  skillIngestQueue: {},
}));
import { enqueueSkillIngestJob } from "./queue";
test("system queue audit has explicit system scope and no invented tenant", async () => {
  await enqueueSkillIngestJob({
    id: "system-job",
    scope: "system",
    teamId: null,
    workspaceId: null,
    attempts: 2,
  });
  expect(enqueue.mock.calls.at(-1)?.[1]).toEqual({
    submissionId: "system-job",
    scope: "system",
    teamId: null,
    workspaceId: null,
  });
  expect(enqueue.mock.calls.at(-1)?.[2]).toMatchObject({
    jobId: "skill-registry-ingest_system-job_2",
  });
});
test("workspace queue attribution stays tenant scoped", async () => {
  await enqueueSkillIngestJob({
    id: "user-job",
    scope: "workspace",
    teamId: "t",
    workspaceId: "w",
    attempts: 0,
  });
  expect(enqueue.mock.calls.at(-1)?.[1]).toEqual({
    submissionId: "user-job",
    scope: "workspace",
    teamId: "t",
    workspaceId: "w",
  });
});
