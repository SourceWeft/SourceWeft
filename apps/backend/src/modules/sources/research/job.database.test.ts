import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import type { ContentBillingPort } from "../../content/billing-port";
import type { ResearchJobPayload } from "../../content/queue";
import type { runResearch } from "./loop";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * Issue #678: the research service and worker job against real research_runs
 * rows. The loop itself is faked (`runLoop`); what is proven here is how the
 * job claims, guards and settles a run, and how the service admits one.
 */

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let repo: typeof import("./repository");
let job: typeof import("./job");
let service: typeof import("./service");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;
let userId: string;

const billing = {} as unknown as ContentBillingPort;

const web: AgentToolWebProvider = {
  name: "stub",
  search: async (input) => ({
    provider: "stub",
    query: input.query,
    count: 0,
    results: [],
  }),
  fetch: async () => ({ provider: "stub", count: 0, results: [] }),
};

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("research_job");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repo = await import("./repository");
  job = await import("./job");
  service = await import("./service");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, userId] = [randomUUID(), randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Research",
    slug: `research-${workspaceId}`,
  });
  // A guest membership is the lightest row that makes the initiator a member of
  // the workspace, so access resolution (and billing) treats them as the payer.
  await schema.db.insert(schema.workspaceMemberships).values({
    workspaceId,
    userId,
    role: "editor",
    source: "guest",
  });
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function makeLoop(impl: typeof runResearch) {
  let calls = 0;
  const fn: typeof runResearch = async (input, deps) => {
    calls += 1;
    return impl(input, deps);
  };
  return { fn, count: () => calls };
}

const jobInput = (
  runId: string,
  extra: { createdByUserId?: string; isFinalAttempt?: boolean } = {},
): ResearchJobPayload & { isFinalAttempt: boolean; scopeId: string } => ({
  runId,
  teamId,
  workspaceId,
  userId: extra.createdByUserId ?? userId,
  isFinalAttempt: extra.isFinalAttempt ?? false,
  scopeId: `job-${runId}`,
});

test("a ready loop result finishes the run ready with a finishedAt", async () => {
  const run = await repo.createRun({ teamId, workspaceId, userId, topic: "T" });
  const loop = makeLoop(async () => ({
    status: "ready",
    report: "# R",
    citations: [],
  }));
  await job.processResearchJob(jobInput(run.id), {
    billing,
    web,
    runLoop: loop.fn,
  });
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "ready");
  assert.equal(found?.reportMarkdown, "# R");
  assert.ok(found?.finishedAt);
  assert.equal(loop.count(), 1);
});

test("a cancelled loop result finishes the run cancelled", async () => {
  const run = await repo.createRun({ teamId, workspaceId, userId, topic: "T" });
  const loop = makeLoop(async () => ({ status: "cancelled" }));
  await job.processResearchJob(jobInput(run.id), {
    billing,
    web,
    runLoop: loop.fn,
  });
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "cancelled");
  assert.ok(found?.finishedAt);
});

test("an initiator who is no longer a member fails ACCESS_LOST and never runs the loop", async () => {
  const stranger = randomUUID();
  const run = await repo.createRun({
    teamId,
    workspaceId,
    userId: stranger,
    topic: "T",
  });
  const loop = makeLoop(async () => {
    throw new Error("the loop must not run");
  });
  await job.processResearchJob(jobInput(run.id, { createdByUserId: stranger }), {
    billing,
    web,
    runLoop: loop.fn,
  });
  const found = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(found?.status, "failed");
  assert.equal(found?.errorCode, "ACCESS_LOST");
  assert.equal(loop.count(), 0);
});

test("the same run executed twice does not change the first result", async () => {
  const run = await repo.createRun({ teamId, workspaceId, userId, topic: "T" });
  const loop = makeLoop(async () => ({
    status: "ready",
    report: "# once",
    citations: [],
  }));
  await job.processResearchJob(jobInput(run.id), {
    billing,
    web,
    runLoop: loop.fn,
  });
  const after1 = await repo.findRun({ teamId, workspaceId, id: run.id });
  await job.processResearchJob(jobInput(run.id), {
    billing,
    web,
    runLoop: loop.fn,
  });
  const after2 = await repo.findRun({ teamId, workspaceId, id: run.id });
  assert.equal(loop.count(), 1);
  assert.equal(after2?.status, "ready");
  assert.equal(after2?.reportMarkdown, "# once");
  assert.equal(after2?.finishedAt?.getTime(), after1?.finishedAt?.getTime());
});

test("createResearch at the concurrency limit returns limited and does not enqueue", async () => {
  await schema.db.insert(schema.sourceResearchRuns).values({
    id: randomUUID(),
    teamId,
    workspaceId,
    createdByUserId: userId,
    topic: "already running",
    status: "running",
  });
  let enqueued = 0;
  const result = await service.createResearch(
    { workspaceId, userId, topic: "Solid-state batteries", requestId: "req-1" },
    {
      billing,
      getProvider: async () => web,
      hasCredits: async () => true,
      enqueue: async () => {
        enqueued += 1;
        return { created: true };
      },
    },
  );
  assert.equal(result.kind, "limited");
  assert.equal(result.kind === "limited" && result.code, "CONCURRENCY_LIMIT");
  assert.equal(enqueued, 0);
});

test("createResearch admits, records a queued run and enqueues it once", async () => {
  let enqueued = 0;
  const result = await service.createResearch(
    { workspaceId, userId, topic: "Grid storage", requestId: "req-2" },
    {
      billing,
      getProvider: async () => web,
      hasCredits: async () => true,
      enqueue: async (payload) => {
        enqueued += 1;
        assert.equal(payload.workspaceId, workspaceId);
        return { created: true };
      },
    },
  );
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    const found = await repo.findRun({ teamId, workspaceId, id: result.run.id });
    assert.equal(found?.status, "queued");
    assert.equal(found?.topic, "Grid storage");
    assert.equal(found?.createdByUserId, userId);
  }
  assert.equal(enqueued, 1);
});
