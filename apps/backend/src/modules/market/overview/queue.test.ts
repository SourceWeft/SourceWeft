import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import type { McpOverviewAttemptRow } from "./repository";

vi.mock("./repository", () => ({
  findMcpOverviewAttempts: vi.fn(),
  findNewMcpOverviewCandidates: vi.fn(),
  mcpOverviewStore: {},
}));

import { mcpOverviewInputOf } from "./source";
import {
  MCP_OVERVIEW_BATCH_SIZE,
  MCP_OVERVIEW_GENERATE_JOB,
  enqueueMcpOverviews,
  findMcpOverviewCandidates,
  mcpOverviewJobs,
  type EnqueueMcpOverviewsDeps,
} from "./queue";
import {
  federatedManifest,
  genesis402RegistryServer,
  readmeFixture,
} from "./test-fixtures";

const readme = readmeFixture("genesis402-mcp-readme.md");
const stored = {
  manifestJson: federatedManifest(genesis402RegistryServer) as unknown,
  provenanceJson: {} as unknown,
  readmeStatus: "ok" as const,
  readmeSha256: readme.sha256,
};
const current = mcpOverviewInputOf({
  ...stored,
  readmeMd: readme.markdown,
})!.inputSha256;

function fresh(id: string, installed = false, webExecutable = false) {
  return { versionId: id, serverId: `s-${id}`, installed, webExecutable };
}

function attempt(
  id: string,
  overrides: Partial<McpOverviewAttemptRow> = {},
): McpOverviewAttemptRow {
  return {
    ...fresh(id),
    ...stored,
    hasReadmeText: true,
    status: "ready",
    error: null,
    readmeReadSince: false,
    overviewSha256: current,
    ...overrides,
  };
}

describe("MCP overview candidates", () => {
  test("never-analysed versions and stale analysed ones, installed first, then web", async () => {
    const scan = await findMcpOverviewCandidates(
      { limit: 10, after: "", window: 10, batchSize: 20 },
      {
        findNew: async () => [fresh("n1"), fresh("n2", false, true)],
        findAttempts: async () => [
          attempt("a1"),
          attempt("a2", { overviewSha256: "e".repeat(64), installed: true }),
          attempt("a3", { status: "failed", error: "system-model-not-ready" }),
          attempt("a4", { status: "failed", error: "no-content" }),
        ],
      },
    );
    assert.deepEqual(
      scan.candidates.map((c) => [c.versionId, c.attempted]),
      [
        ["a2", true],
        ["n2", false],
        ["n1", false],
        ["a3", true],
      ],
    );
    // A short window was the end of the catalog: start over next time.
    assert.equal(scan.next, "");
  });

  test("the rotating window moves on, and stays while it holds more than a batch", async () => {
    const window = 3;
    const full = [attempt("a1"), attempt("a2"), attempt("a3")];
    const moved = await findMcpOverviewCandidates(
      { limit: 10, after: "a0", window, batchSize: 20 },
      { findNew: async () => [], findAttempts: async () => full },
    );
    assert.equal(moved.next, "a3");

    const stale = full.map((row) => ({ ...row, overviewSha256: null }));
    const stays = await findMcpOverviewCandidates(
      { limit: 10, after: "a0", window, batchSize: 2 },
      { findNew: async () => [], findAttempts: async () => stale },
    );
    assert.equal(stays.candidates.length, 3);
    assert.equal(stays.next, "a0");

    // Many new versions do not hold a window with nothing stale in it.
    const busy = await findMcpOverviewCandidates(
      { limit: 10, after: "a0", window, batchSize: 2 },
      {
        findNew: async () => [fresh("n1"), fresh("n2"), fresh("n3")],
        findAttempts: async () => full,
      },
    );
    assert.equal(busy.next, "a3");
  });
});

describe("the MCP overview tick", () => {
  function deps(
    overrides: Partial<EnqueueMcpOverviewsDeps> = {},
  ): EnqueueMcpOverviewsDeps & { enqueued: unknown[] } {
    const enqueued: unknown[] = [];
    return {
      enqueued,
      readModelReadiness: async () => ({ ready: true, reason: null }),
      findCandidates: async () => ({
        candidates: [
          { ...fresh("n1"), attempted: false },
          { ...fresh("a1"), attempted: true },
        ],
        next: "a1",
      }),
      jobExists: async () => false,
      recover: async () => 0,
      enqueue: async (payload) => {
        enqueued.push(payload);
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("queues nothing while the system model is not ready", async () => {
    const findCandidates = vi.fn();
    const recover = vi.fn();
    const tick = deps({
      readModelReadiness: async () => ({
        ready: false,
        reason: "SYSTEM_MODEL_ENABLED is not true",
      }),
      findCandidates,
      recover,
    });
    assert.deepEqual(await enqueueMcpOverviews(tick, { after: "" }), {
      queued: 0,
      skipped: 0,
    });
    assert.equal(findCandidates.mock.calls.length, 0);
    assert.equal(recover.mock.calls.length, 0);
    assert.deepEqual(tick.enqueued, []);
  });

  test("queues new versions as scheduled and analysed ones as forced, and moves the window", async () => {
    const tick = deps();
    const state = { after: "" };
    assert.deepEqual(await enqueueMcpOverviews(tick, state), {
      queued: 2,
      skipped: 0,
    });
    assert.deepEqual(tick.enqueued, [
      { mcpServerVersionId: "n1", mcpServerId: "s-n1", reason: "scheduled" },
      { mcpServerVersionId: "a1", mcpServerId: "s-a1", reason: "regenerate" },
    ]);
    assert.equal(state.after, "a1");
  });

  test("queues at most a batch per tick", async () => {
    const tick = deps({
      findCandidates: async () => ({
        candidates: Array.from(
          { length: MCP_OVERVIEW_BATCH_SIZE + 5 },
          (_, index) => ({ ...fresh(`n${index}`), attempted: false }),
        ),
        next: "",
      }),
    });
    const result = await enqueueMcpOverviews(tick, { after: "" });
    assert.equal(result.queued, MCP_OVERVIEW_BATCH_SIZE);
    assert.equal(tick.enqueued.length, MCP_OVERVIEW_BATCH_SIZE);
  });

  test("the tick's batch size is the scheduler's, and the scan reads at least a batch", async () => {
    function ticking() {
      const scans: unknown[] = [];
      const tick = deps({
        findCandidates: async (input) => {
          scans.push(input);
          return {
            candidates: Array.from({ length: 4 }, (_, index) => ({
              ...fresh(`n${index}`),
              attempted: false,
            })),
            next: "",
          };
        },
      });
      return { tick, scans };
    }

    const small = ticking();
    const fewer = await enqueueMcpOverviews(
      small.tick,
      { after: "" },
      { batchSize: 2 },
    );
    assert.equal(fewer.queued, 2);
    assert.equal(small.tick.enqueued.length, 2);
    assert.deepEqual(small.scans, [{ limit: 200, after: "", batchSize: 2 }]);

    const large = ticking();
    const all = await enqueueMcpOverviews(
      large.tick,
      { after: "" },
      { batchSize: 500 },
    );
    assert.equal(all.queued, 4);
    assert.deepEqual(large.scans, [{ limit: 500, after: "", batchSize: 500 }]);
  });

  test("the job is named and bounded like the skill kind's", () => {
    assert.equal(mcpOverviewJobs.spec.name, MCP_OVERVIEW_GENERATE_JOB);
    assert.equal(MCP_OVERVIEW_GENERATE_JOB, "mcp-overview-generate");
    assert.equal(mcpOverviewJobs.spec.versionKey, "mcpServerVersionId");
    assert.equal(mcpOverviewJobs.spec.parentKey, "mcpServerId");
    assert.equal(mcpOverviewJobs.spec.attempts, 3);
  });
});
