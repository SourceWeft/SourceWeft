import assert from "node:assert/strict";
import { test, vi } from "vitest";

// The queue and the database are both behind injected deps here; the real
// modules are never reached, but importing them must not open connections.
vi.mock("../../../shared/queue", () => ({
  enqueueWithAudit: vi.fn(),
  jobsQueue: {},
}));

vi.mock("./analysis-repository", () => ({
  requestSkillAnalysis: vi.fn(),
  failSkillAnalysis: vi.fn(),
}));
vi.mock("./overview-repository", () => ({
  findSkillOverviewCandidates: vi.fn(),
  readSkillOverviewBilling: vi.fn(),
}));

import { SKILL_OVERVIEW_BATCH_SIZE, enqueueSkillOverviews } from "./overviews";
import { skillOverviewJobId } from "./overview-queue";

const billing = { teamId: "team_1", workspaceId: "ws_1", userId: "user_1" };

function candidates(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    skillId: `skill_${i}`,
    skillVersionId: `ver_${i}`,
    bundleSha256: `sha_${i}`,
  }));
}

test("nothing happens while no billing team is set", async () => {
  const deps = {
    readBilling: vi.fn(async () => null),
    findCandidates: vi.fn(async () => candidates(3)),
    jobExists: vi.fn(async () => false),
    enqueue: vi.fn(async () => undefined),
  };
  assert.deepEqual(await enqueueSkillOverviews(deps), {
    queued: 0,
    copied: 0,
    skipped: 0,
  });
  assert.equal(deps.findCandidates.mock.calls.length, 0);
  assert.equal(deps.enqueue.mock.calls.length, 0);
});

test("queues one job per version up to the batch size; cache reuse belongs to the worker", async () => {
  const enqueued: Array<Record<string, unknown>> = [];
  const deps = {
    readBilling: vi.fn(async () => billing),
    findCandidates: vi.fn(async () =>
      candidates(SKILL_OVERVIEW_BATCH_SIZE + 10),
    ),
    // The first two already have a job (queued, or failed for good).
    jobExists: vi.fn(
      async (jobId: string) =>
        jobId === skillOverviewJobId("ver_0") ||
        jobId === skillOverviewJobId("ver_1"),
    ),
    enqueue: vi.fn(async (payload: Record<string, unknown>) => {
      enqueued.push(payload);
    }),
  };
  const result = await enqueueSkillOverviews(deps);
  assert.deepEqual(result, {
    queued: SKILL_OVERVIEW_BATCH_SIZE,
    copied: 0,
    skipped: 2,
  });
  assert.equal(enqueued.length, SKILL_OVERVIEW_BATCH_SIZE);
  assert.deepEqual(enqueued[0], {
    skillVersionId: "ver_2",
    skillId: "skill_2",
    reason: "scheduled",
    teamId: "team_1",
    workspaceId: "ws_1",
  });
  // Deterministic, so the same version queued twice is one job.
  assert.equal(skillOverviewJobId("ver_2"), "skill-overview-generate_ver_2");
});
