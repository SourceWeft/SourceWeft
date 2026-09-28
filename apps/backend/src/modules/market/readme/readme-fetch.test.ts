import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";

const logs = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../../../shared/logger", () => ({
  logger: { warn: logs.warn, info: logs.info, debug: vi.fn(), error: vi.fn() },
}));

import {
  fetchMcpReadmeBatch,
  MCP_README_CLAIM_LEASE_MS,
  MCP_README_CONCURRENCY,
  MCP_README_MIN_POINTS,
  scheduleDueMcpReadmes,
  type FetchMcpReadmeBatchDeps,
} from "./readme-fetch";
import {
  MCP_README_BATCH_SIZE,
  MCP_README_SCHEDULED_JOB_ID,
  type McpReadmeBatchSummary,
} from "./readme-queue";
import type { ClaimedMcpReadme } from "./readme-repository";
import type { McpReadmeColumns } from "./readme-state";
import {
  GITHUB_README_QUERY_SIZE,
  type GitHubReadmeResult,
  type GitHubReadmeTarget,
} from "./github-readme";

const NOW = new Date("2026-09-28T10:00:00Z");
const COMMIT = "c0ffee".padEnd(40, "0");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduling", () => {
  test("queues one batch of the due versions, in the order they were found", async () => {
    const findDue = vi.fn(async () => [
      {
        versionId: "v-installed",
        identifier: "a",
        installed: true,
        neverRead: false,
      },
      {
        versionId: "v-new",
        identifier: "b",
        installed: false,
        neverRead: true,
      },
    ]);
    const enqueue = vi.fn(async () => undefined);
    const result = await scheduleDueMcpReadmes({
      jobExists: async () => false,
      findDue,
      enqueue,
    });
    assert.deepEqual(result, { queued: 2, inFlight: false });
    assert.deepEqual(findDue.mock.calls[0], [{ limit: MCP_README_BATCH_SIZE }]);
    assert.equal(MCP_README_BATCH_SIZE, 5000);
    assert.deepEqual(enqueue.mock.calls[0], [
      { versionIds: ["v-installed", "v-new"], reason: "scheduled" },
      MCP_README_SCHEDULED_JOB_ID,
    ]);
  });

  test("queues nothing while the previous batch is queued or running", async () => {
    const findDue = vi.fn();
    const enqueue = vi.fn();
    const result = await scheduleDueMcpReadmes({
      jobExists: async (jobId) => jobId === MCP_README_SCHEDULED_JOB_ID,
      findDue,
      enqueue,
    });
    assert.deepEqual(result, { queued: 0, inFlight: true });
    assert.equal(findDue.mock.calls.length, 0);
    assert.equal(enqueue.mock.calls.length, 0);
  });

  test("queues nothing when nothing is due", async () => {
    const enqueue = vi.fn();
    const result = await scheduleDueMcpReadmes({
      jobExists: async () => false,
      findDue: async () => [],
      enqueue,
    });
    assert.deepEqual(result, { queued: 0, inFlight: false });
    assert.equal(enqueue.mock.calls.length, 0);
  });
});

function claimed(
  versionId: string,
  overrides: Partial<ClaimedMcpReadme> = {},
): ClaimedMcpReadme {
  return {
    versionId,
    identifier: `io.github.acme/${versionId}`,
    repoUrl: `https://github.com/acme/${versionId}`,
    provenanceJson: {},
    readmeStatus: "pending",
    readmeAttempts: 0,
    readmeSha256: null,
    readmePath: null,
    ...overrides,
  };
}

/**
 * The batch's dependencies over an in-memory set of rows. GitHub answers per
 * repository name from `results`; a repository with no entry makes the whole
 * read throw. `points` is what GitHub says is left after each read.
 */
function harness(input: {
  rows: Record<string, ClaimedMcpReadme | null>;
  results?: Record<string, GitHubReadmeResult>;
  points?: number;
  hasToken?: boolean;
}) {
  const writes: Array<[string, McpReadmeColumns]> = [];
  const recorded: McpReadmeBatchSummary[] = [];
  const results = input.results ?? {};
  const deps = {
    claim: vi.fn(
      async ({ versionIds }: { versionIds: string[]; leaseUntil: Date }) =>
        // In another order than asked: the batch must not rely on it.
        versionIds.flatMap((id) => input.rows[id] ?? []).reverse(),
    ),
    write: vi.fn(async (versionId: string, columns: McpReadmeColumns) => {
      writes.push([versionId, columns]);
    }),
    defer: vi.fn(
      async ({ versionIds }: { versionIds: string[] }) => versionIds.length,
    ),
    fetchReadmes: vi.fn(async (targets: GitHubReadmeTarget[]) => ({
      results: targets.map(({ repo }) => {
        const result = results[repo];
        if (!result) throw new Error(`unexpected fetch for ${repo}`);
        return result;
      }),
      cost: 1,
      remaining: input.points ?? 4000,
      resetAt: RESET,
    })),
    hasToken: () => input.hasToken ?? true,
    record: vi.fn(async (summary: McpReadmeBatchSummary) => {
      recorded.push(summary);
    }),
    now: () => NOW,
  } satisfies FetchMcpReadmeBatchDeps;
  return { deps, writes, recorded };
}

const RESET = new Date(NOW.getTime() + 40 * 60 * 1000);
const SHA = "a".repeat(64);

const okResult = (path: string): GitHubReadmeResult => ({
  status: "ok",
  markdown: "# Hi",
  path,
  ref: COMMIT,
  sha256: SHA,
  byteSize: 4,
});

const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe("fetching a batch", () => {
  test("claims a group, reads its directories in one call and stores each outcome", async () => {
    const { deps, writes, recorded } = harness({
      rows: {
        root: claimed("root"),
        sub: claimed("sub", {
          provenanceJson: { repository: { subfolder: "mcp" } },
        }),
        gone: null,
      },
      results: { root: okResult("README.md"), sub: okResult("mcp/README.md") },
    });

    const summary = await fetchMcpReadmeBatch(
      { versionIds: ["root", "gone", "sub"], reason: "scheduled" },
      deps,
    );

    assert.equal(deps.claim.mock.calls.length, 1);
    const [claim] = deps.claim.mock.calls[0]!;
    assert.deepEqual(claim.versionIds, ["root", "gone", "sub"]);
    assert.equal(
      claim.leaseUntil.getTime() - NOW.getTime(),
      MCP_README_CLAIM_LEASE_MS,
    );
    // One read for the group, in the order the batch asked for.
    assert.deepEqual(deps.fetchReadmes.mock.calls, [
      [
        [
          { owner: "acme", repo: "root", subfolder: "" },
          { owner: "acme", repo: "sub", subfolder: "mcp" },
        ],
      ],
    ]);
    assert.deepEqual(
      writes.map(([id, columns]) => [
        id,
        columns.readmeStatus,
        columns.readmePath,
      ]),
      [
        ["root", "ok", "README.md"],
        ["sub", "ok", "mcp/README.md"],
      ],
    );
    assert.equal(summary.processed, 2);
    assert.equal(summary.skipped, 1);
    assert.deepEqual(summary.outcomes, { ok: 2 });
    assert.equal(summary.tokenPresent, true);
    assert.equal(summary.points, 1);
    assert.equal(summary.pointsRemaining, 4000);
    assert.equal(summary.stoppedBy, null);
    assert.deepEqual(recorded, [summary]);
  });

  test("reads groups of one query's size, a few at a time", async () => {
    const versionIds = ids("v", GITHUB_README_QUERY_SIZE * 4 + 3);
    const { deps, writes } = harness({
      rows: Object.fromEntries(versionIds.map((id) => [id, claimed(id)])),
      results: Object.fromEntries(
        versionIds.map((id) => [id, okResult("README.md")]),
      ),
    });
    let inFlight = 0;
    let most = 0;
    const read = deps.fetchReadmes.getMockImplementation()!;
    deps.fetchReadmes.mockImplementation(async (targets) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return read(targets);
    });

    const summary = await fetchMcpReadmeBatch(
      { versionIds, reason: "scheduled" },
      deps,
    );

    assert.deepEqual(
      deps.fetchReadmes.mock.calls.map(([targets]) => targets.length),
      [20, 20, 20, 20, 3],
    );
    assert.equal(most, MCP_README_CONCURRENCY);
    assert.equal(writes.length, versionIds.length);
    assert.equal(summary.points, 5);
  });

  test("the README already stored only moves the fetch times", async () => {
    const { deps, writes } = harness({
      rows: {
        same: claimed("same", {
          readmeStatus: "ok",
          readmeSha256: SHA,
          readmePath: "servers/same/README.md",
        }),
        changed: claimed("changed", {
          readmeStatus: "ok",
          readmeSha256: "b".repeat(64),
          readmePath: "README.md",
        }),
      },
      results: {
        same: okResult("servers/same/README.md"),
        changed: okResult("README.md"),
      },
    });
    const summary = await fetchMcpReadmeBatch(
      { versionIds: ["same", "changed"], reason: "scheduled" },
      deps,
    );
    // A known README is read where it was found.
    assert.equal(
      deps.fetchReadmes.mock.calls[0]?.[0][0]?.subfolder,
      "servers/same",
    );
    const [same, changed] = writes;
    assert.equal(same?.[1].readmeStatus, undefined);
    assert.equal(same?.[1].readmeMd, undefined);
    assert.ok(same?.[1].readmeFetchedAt);
    assert.equal(changed?.[1].readmeMd, "# Hi");
    assert.deepEqual(summary.outcomes, { not_modified: 1, ok: 1 });
  });

  test("a repository that is not on GitHub is recorded without a request", async () => {
    const { deps, writes } = harness({
      rows: {
        gitlab: claimed("gitlab", {
          repoUrl: "https://gitlab.com/acme/gitlab",
        }),
        none: claimed("none", { repoUrl: null }),
      },
    });
    await fetchMcpReadmeBatch(
      { versionIds: ["gitlab", "none"], reason: "scheduled" },
      deps,
    );
    assert.equal(deps.fetchReadmes.mock.calls.length, 0);
    assert.deepEqual(
      writes.map(([, columns]) => columns.readmeStatus),
      ["unsupported_host", "unsupported_host"],
    );
    // A server with no repository at all is told apart from one elsewhere.
    assert.deepEqual(
      writes.map(([, columns]) => columns.readmeError),
      ["The repository is not on github.com", "The server lists no repository"],
    );
  });

  test("a spent rate limit stops the batch and defers what was not reached", async () => {
    const resetAt = new Date(NOW.getTime() + 25 * 60 * 1000);
    const first = ids("a", GITHUB_README_QUERY_SIZE);
    const later = ids("b", GITHUB_README_QUERY_SIZE * 5);
    const { deps, writes } = harness({
      rows: Object.fromEntries(
        [...first, ...later].map((id) => [
          id,
          claimed(
            id,
            id === "a1" ? { readmeAttempts: 2, readmeStatus: "error" } : {},
          ),
        ]),
      ),
      results: Object.fromEntries([
        ...first.map((id) => [
          id,
          id === "a0"
            ? okResult("README.md")
            : ({ status: "rate_limited", resetAt } as const),
        ]),
        ...later.map((id) => [id, okResult("README.md")]),
      ]),
    });
    // The first group meets the limit while the two read beside it are still
    // waiting for GitHub.
    const read = deps.fetchReadmes.getMockImplementation()!;
    deps.fetchReadmes.mockImplementation(async (targets) => {
      if (targets[0]?.repo !== "a0") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return read(targets);
    });

    const summary = await fetchMcpReadmeBatch(
      { versionIds: [...first, ...later], reason: "scheduled" },
      deps,
    );

    // No attempt is counted for the versions that met the limit.
    assert.deepEqual(
      writes.find(([id]) => id === "a1"),
      ["a1", { readmeNextFetchAt: resetAt }],
    );
    // Groups already being read finish; the rest wait for the reset.
    assert.deepEqual(summary.outcomes, {
      ok: 1 + (MCP_README_CONCURRENCY - 1) * GITHUB_README_QUERY_SIZE,
      rate_limited: GITHUB_README_QUERY_SIZE - 1,
    });
    assert.deepEqual(deps.defer.mock.calls[0]?.[0], {
      versionIds: later.slice(
        (MCP_README_CONCURRENCY - 1) * GITHUB_README_QUERY_SIZE,
      ),
      until: resetAt,
      now: NOW,
    });
    assert.equal(summary.stoppedBy, "rate_limited");
    assert.equal(summary.rateLimitedUntil, resetAt.toISOString());
    assert.equal(
      summary.deferred,
      later.length - (MCP_README_CONCURRENCY - 1) * GITHUB_README_QUERY_SIZE,
    );
  });

  test("points running low stop the batch before the limit is met", async () => {
    const versionIds = ids("v", GITHUB_README_QUERY_SIZE * 5);
    const { deps } = harness({
      rows: Object.fromEntries(versionIds.map((id) => [id, claimed(id)])),
      results: Object.fromEntries(
        versionIds.map((id) => [id, okResult("README.md")]),
      ),
      points: MCP_README_MIN_POINTS - 1,
    });
    const summary = await fetchMcpReadmeBatch(
      { versionIds, reason: "scheduled" },
      deps,
    );
    assert.equal(summary.stoppedBy, "rate_limited");
    assert.equal(summary.rateLimitedUntil, RESET.toISOString());
    // The groups already started finish; nothing after them is read.
    assert.equal(deps.fetchReadmes.mock.calls.length, MCP_README_CONCURRENCY);
    assert.equal(
      summary.deferred,
      versionIds.length - MCP_README_CONCURRENCY * GITHUB_README_QUERY_SIZE,
    );
  });

  test("a refused token writes nothing and stops the batch without deferring", async () => {
    const versionIds = ids("v", GITHUB_README_QUERY_SIZE * 5);
    const { deps, writes } = harness({
      rows: Object.fromEntries(versionIds.map((id) => [id, claimed(id)])),
      results: Object.fromEntries(
        versionIds.map((id) => [
          id,
          {
            status: "unauthorized",
            message: "GitHub did not accept GITHUB_TOKEN (401)",
          } as const,
        ]),
      ),
    });
    const summary = await fetchMcpReadmeBatch(
      { versionIds, reason: "scheduled" },
      deps,
    );
    assert.equal(writes.length, 0);
    assert.equal(summary.processed, 0);
    assert.equal(summary.stoppedBy, "unauthorized");
    assert.equal(summary.rateLimitedUntil, null);
    // Left due (or leased): a fixed token is used by the next batch.
    assert.equal(deps.defer.mock.calls.length, 0);
    assert.equal(
      logs.warn.mock.calls.filter(([message]) =>
        String(message).includes("stopped early"),
      ).length,
      1,
    );
  });

  test("without GITHUB_TOKEN nothing is claimed or read, and the batch says why", async () => {
    const { deps, recorded, writes } = harness({
      rows: { a: claimed("a"), b: claimed("b") },
      hasToken: false,
    });
    const summary = await fetchMcpReadmeBatch(
      { versionIds: ["a", "b"], reason: "scheduled" },
      deps,
    );
    assert.equal(deps.claim.mock.calls.length, 0);
    assert.equal(deps.fetchReadmes.mock.calls.length, 0);
    assert.equal(writes.length, 0);
    assert.equal(summary.tokenPresent, false);
    assert.equal(summary.stoppedBy, "no_token");
    assert.deepEqual(recorded, [summary]);
    assert.equal(
      logs.warn.mock.calls.filter(([message]) =>
        String(message).includes("GITHUB_TOKEN"),
      ).length,
      1,
    );
  });

  test("an error is counted against the version, and a throw is recorded like one", async () => {
    const { deps, writes } = harness({
      rows: {
        flaky: claimed("flaky", { readmeAttempts: 1, readmeStatus: "error" }),
      },
      results: {
        flaky: {
          status: "error",
          message: "GitHub GraphQL request failed 502",
        },
      },
    });
    const summary = await fetchMcpReadmeBatch(
      { versionIds: ["flaky"], reason: "admin" },
      deps,
    );
    assert.equal(writes[0]?.[1].readmeAttempts, 2);
    assert.equal(
      writes[0]?.[1].readmeError,
      "GitHub GraphQL request failed 502",
    );
    assert.equal(summary.reason, "admin");

    const broken = harness({ rows: { broken: claimed("broken") } });
    const brokenSummary = await fetchMcpReadmeBatch(
      { versionIds: ["broken"], reason: "scheduled" },
      broken.deps,
    );
    assert.equal(broken.writes[0]?.[1].readmeStatus, "error");
    assert.equal(
      broken.writes[0]?.[1].readmeError,
      "unexpected fetch for broken",
    );
    assert.deepEqual(brokenSummary.outcomes, { error: 1 });
  });
});
