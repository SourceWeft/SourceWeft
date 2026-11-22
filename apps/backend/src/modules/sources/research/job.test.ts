import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import type {
  ResearchErrorCode,
  ResearchStatus,
} from "@sourceweft/contracts/source-research";
import type { ContentBillingPort } from "../../content/billing-port";
import type { GuidePayer } from "../guide-payer";
import { processResearchJob, type ResearchJobRepo } from "./job";
import type { runResearch } from "./loop";
import type { ResearchRunRow } from "./repository";

/**
 * Issue #678: the worker job's orchestration, with the repository, the payer
 * resolution and the loop all faked so the state machine is exercised without a
 * database.
 */

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

const payer: GuidePayer = {
  userId: "user-1",
  billingOrganizationId: "billing-org",
};

function baseRow(overrides: Partial<ResearchRunRow> = {}): ResearchRunRow {
  const now = new Date("2026-11-22T00:00:00.000Z");
  return {
    id: "run-1",
    teamId: "team-1",
    workspaceId: "ws-1",
    createdByUserId: "user-1",
    topic: "Solid-state batteries",
    status: "queued",
    phase: null,
    progressJson: { round: 0, searches: 0, pagesRead: 0, modelCalls: 0 },
    planJson: null,
    ledgerJson: [],
    reportMarkdown: null,
    reportCitationsJson: null,
    modelCalls: 0,
    errorCode: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const TERMINAL: readonly ResearchStatus[] = ["ready", "failed", "cancelled"];

function makeRepo(initial: ResearchRunRow) {
  let row = initial;
  const calls = {
    markRunning: 0,
    finishReady: 0,
    finishFailed: 0,
    finishCancelled: 0,
  };
  const nonTerminal = () => !TERMINAL.includes(row.status);
  const repo: ResearchJobRepo = {
    markRunning: async () => {
      calls.markRunning += 1;
      if (row.status !== "queued") return false;
      row = { ...row, status: "running", startedAt: row.startedAt ?? new Date() };
      return true;
    },
    findRun: async () => row,
    saveProgress: async () => {},
    isCancelRequested: async () => false,
    finishReady: async (_id, result) => {
      if (!nonTerminal()) return false;
      row = {
        ...row,
        status: "ready",
        reportMarkdown: result.report,
        reportCitationsJson: result.citations,
        finishedAt: new Date(),
      };
      calls.finishReady += 1;
      return true;
    },
    finishFailed: async (_id, errorCode: ResearchErrorCode) => {
      if (!nonTerminal()) return false;
      row = { ...row, status: "failed", errorCode, finishedAt: new Date() };
      calls.finishFailed += 1;
      return true;
    },
    finishCancelled: async (_id) => {
      if (!nonTerminal()) return false;
      row = { ...row, status: "cancelled", finishedAt: new Date() };
      calls.finishCancelled += 1;
      return true;
    },
  };
  return { repo, get: () => row, calls };
}

type RunLoop = typeof runResearch;
type RunLoopInput = Parameters<RunLoop>[0];

function makeLoop(impl: RunLoop) {
  const inputs: RunLoopInput[] = [];
  const fn: RunLoop = async (input, deps) => {
    inputs.push(input);
    return impl(input, deps);
  };
  return { fn, inputs };
}

const payload = {
  runId: "run-1",
  teamId: "team-1",
  workspaceId: "ws-1",
  userId: "user-1",
  scopeId: "job-1",
};

test("a ready result is written as a ready run", async () => {
  const store = makeRepo(baseRow());
  const loop = makeLoop(async () => ({
    status: "ready",
    report: "# Report",
    citations: [],
  }));
  await processResearchJob(
    { ...payload, isFinalAttempt: false },
    { billing, web, repo: store.repo, resolvePayer: async () => payer, runLoop: loop.fn },
  );
  assert.equal(store.get().status, "ready");
  assert.equal(store.get().reportMarkdown, "# Report");
  assert.ok(store.get().finishedAt);
  assert.equal(store.calls.finishReady, 1);
  assert.equal(loop.inputs.length, 1);
});

test("a cancelled result is written as a cancelled run", async () => {
  const store = makeRepo(baseRow());
  const loop = makeLoop(async () => ({ status: "cancelled" }));
  await processResearchJob(
    { ...payload, isFinalAttempt: false },
    { billing, web, repo: store.repo, resolvePayer: async () => payer, runLoop: loop.fn },
  );
  assert.equal(store.get().status, "cancelled");
  assert.ok(store.get().finishedAt);
  assert.equal(store.calls.finishCancelled, 1);
});

test("a failed result records its error code", async () => {
  const store = makeRepo(baseRow());
  const loop = makeLoop(async () => ({ status: "failed", errorCode: "NO_RESULTS" }));
  await processResearchJob(
    { ...payload, isFinalAttempt: false },
    { billing, web, repo: store.repo, resolvePayer: async () => payer, runLoop: loop.fn },
  );
  assert.equal(store.get().status, "failed");
  assert.equal(store.get().errorCode, "NO_RESULTS");
});

test("a lost initiator fails ACCESS_LOST without entering the loop", async () => {
  const store = makeRepo(baseRow());
  const loop = makeLoop(async () => {
    throw new Error("the loop must not run");
  });
  await processResearchJob(
    { ...payload, isFinalAttempt: false },
    { billing, web, repo: store.repo, resolvePayer: async () => null, runLoop: loop.fn },
  );
  assert.equal(store.get().status, "failed");
  assert.equal(store.get().errorCode, "ACCESS_LOST");
  assert.equal(loop.inputs.length, 0);
});

test("a transient failure before the final attempt rethrows for retry", async () => {
  const store = makeRepo(baseRow());
  const loop = makeLoop(async () => {
    throw new Error("model timed out");
  });
  await assert.rejects(
    processResearchJob(
      { ...payload, isFinalAttempt: false },
      { billing, web, repo: store.repo, resolvePayer: async () => payer, runLoop: loop.fn },
    ),
  );
  // Left running for the retry, not settled.
  assert.equal(store.get().status, "running");
  assert.equal(store.calls.finishFailed, 0);
});

test("a transient failure on the final attempt settles MODEL_UNAVAILABLE", async () => {
  const store = makeRepo(baseRow());
  const loop = makeLoop(async () => {
    throw new Error("model timed out");
  });
  await processResearchJob(
    { ...payload, isFinalAttempt: true },
    { billing, web, repo: store.repo, resolvePayer: async () => payer, runLoop: loop.fn },
  );
  assert.equal(store.get().status, "failed");
  assert.equal(store.get().errorCode, "MODEL_UNAVAILABLE");
});

test("an already-terminal run is a no-op", async () => {
  const store = makeRepo(
    baseRow({ status: "ready", reportMarkdown: "# Done", finishedAt: new Date() }),
  );
  const loop = makeLoop(async () => {
    throw new Error("the loop must not run");
  });
  await processResearchJob(
    { ...payload, isFinalAttempt: false },
    { billing, web, repo: store.repo, resolvePayer: async () => payer, runLoop: loop.fn },
  );
  assert.equal(store.get().status, "ready");
  assert.equal(store.get().reportMarkdown, "# Done");
  assert.equal(loop.inputs.length, 0);
  assert.equal(store.calls.finishReady, 0);
});

test("a run found still running is resumed from its row with the original clock", async () => {
  const startedAt = new Date("2026-11-22T00:00:00.000Z");
  const ledger = [
    { id: "e1", url: "https://a", title: "A", points: ["p"], quotes: [] },
  ];
  const store = makeRepo(
    baseRow({
      status: "running",
      startedAt,
      planJson: ["q1"],
      ledgerJson: ledger,
      progressJson: { round: 2, searches: 4, pagesRead: 3, modelCalls: 6 },
    }),
  );
  const loop = makeLoop(async () => ({
    status: "ready",
    report: "# Resumed",
    citations: [],
  }));
  await processResearchJob(
    { ...payload, isFinalAttempt: false },
    { billing, web, repo: store.repo, resolvePayer: async () => payer, runLoop: loop.fn },
  );
  assert.equal(store.calls.markRunning, 1);
  const seen = loop.inputs[0];
  assert.deepEqual(seen?.resume?.plan, ["q1"]);
  assert.deepEqual(seen?.resume?.ledger, ledger);
  assert.equal(seen?.resume?.progress.modelCalls, 6);
  assert.equal(seen?.startedAtMs, startedAt.getTime());
  assert.equal(store.get().status, "ready");
});
