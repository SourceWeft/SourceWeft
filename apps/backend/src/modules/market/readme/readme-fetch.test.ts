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
import type { GitHubReadmeResult } from "./github-readme";

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
        webExecutable: false,
      },
      {
        versionId: "v-web",
        identifier: "b",
        installed: false,
        webExecutable: true,
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
    assert.equal(MCP_README_BATCH_SIZE, 200);
    assert.deepEqual(enqueue.mock.calls[0], [
      { versionIds: ["v-installed", "v-web"], reason: "scheduled" },
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
    readmeEtag: null,
    readmePath: null,
    ...overrides,
  };
}

function harness(input: {
  rows: Record<string, ClaimedMcpReadme | null>;
  results: Record<string, GitHubReadmeResult>;
}) {
  const writes: Array<[string, McpReadmeColumns]> = [];
  const recorded: McpReadmeBatchSummary[] = [];
  const deps = {
    claim: vi.fn(
      async ({ versionId }: { versionId: string; leaseUntil: Date }) =>
        input.rows[versionId] ?? null,
    ),
    write: vi.fn(async (versionId: string, columns: McpReadmeColumns) => {
      writes.push([versionId, columns]);
    }),
    defer: vi.fn(
      async ({ versionIds }: { versionIds: string[] }) => versionIds.length,
    ),
    fetchReadme: vi.fn(async ({ repo }: { repo: string }) => {
      const result = input.results[repo];
      if (!result) throw new Error(`unexpected fetch for ${repo}`);
      return result;
    }),
    record: vi.fn(async (summary: McpReadmeBatchSummary) => {
      recorded.push(summary);
    }),
    now: () => NOW,
  } satisfies FetchMcpReadmeBatchDeps;
  return { deps, writes, recorded };
}

const okResult = (path: string): GitHubReadmeResult => ({
  status: "ok",
  markdown: "# Hi",
  path,
  ref: COMMIT,
  sha256: "a".repeat(64),
  etag: '"e"',
  byteSize: 4,
  tokenPresent: true,
});

describe("fetching a batch", () => {
  test("each claimed version is read from its subfolder and its outcome stored", async () => {
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

    assert.deepEqual(
      deps.claim.mock.calls.map(([call]) => [
        call.versionId,
        call.leaseUntil.getTime() - NOW.getTime(),
      ]),
      [
        ["root", MCP_README_CLAIM_LEASE_MS],
        ["gone", MCP_README_CLAIM_LEASE_MS],
        ["sub", MCP_README_CLAIM_LEASE_MS],
      ],
    );
    assert.deepEqual(
      deps.fetchReadme.mock.calls.map(([call]) => call),
      [
        { owner: "acme", repo: "root", subfolder: "", etag: null },
        { owner: "acme", repo: "sub", subfolder: "mcp", etag: null },
      ],
    );
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
    assert.deepEqual(recorded, [summary]);
  });

  test("a stored ETag is sent for a settled README, and a 304 keeps it", async () => {
    const { deps, writes } = harness({
      rows: {
        known: claimed("known", {
          readmeStatus: "ok",
          readmeEtag: '"known"',
          readmePath: "servers/known/README.md",
        }),
      },
      results: { known: { status: "not_modified", tokenPresent: true } },
    });
    await fetchMcpReadmeBatch(
      { versionIds: ["known"], reason: "scheduled" },
      deps,
    );
    assert.deepEqual(deps.fetchReadme.mock.calls[0]?.[0], {
      owner: "acme",
      repo: "known",
      subfolder: "servers/known",
      etag: '"known"',
    });
    assert.equal(writes[0]?.[1].readmeStatus, undefined);
    assert.equal(writes[0]?.[1].readmeMd, undefined);
  });

  test("a repository that is not on GitHub is recorded without a request", async () => {
    const { deps, writes } = harness({
      rows: {
        gitlab: claimed("gitlab", {
          repoUrl: "https://gitlab.com/acme/gitlab",
        }),
        none: claimed("none", { repoUrl: null }),
      },
      results: {},
    });
    const summary = await fetchMcpReadmeBatch(
      { versionIds: ["gitlab", "none"], reason: "scheduled" },
      deps,
    );
    assert.equal(deps.fetchReadme.mock.calls.length, 0);
    assert.deepEqual(
      writes.map(([, columns]) => columns.readmeStatus),
      ["unsupported_host", "unsupported_host"],
    );
    assert.equal(summary.tokenPresent, null);
  });

  test("a spent rate limit stops the batch and defers the rest to the reset", async () => {
    const resetAt = new Date(NOW.getTime() + 25 * 60 * 1000);
    const { deps, writes } = harness({
      rows: {
        first: claimed("first"),
        limited: claimed("limited", {
          readmeAttempts: 2,
          readmeStatus: "error",
        }),
        later: claimed("later"),
        last: claimed("last"),
      },
      results: {
        first: okResult("README.md"),
        limited: { status: "rate_limited", resetAt, tokenPresent: true },
      },
    });
    const summary = await fetchMcpReadmeBatch(
      {
        versionIds: ["first", "limited", "later", "last"],
        reason: "scheduled",
      },
      deps,
    );
    // No attempt is counted for the version that met the limit.
    assert.deepEqual(writes[1], ["limited", { readmeNextFetchAt: resetAt }]);
    assert.deepEqual(deps.defer.mock.calls[0]?.[0], {
      versionIds: ["later", "last"],
      until: resetAt,
      now: NOW,
    });
    // Nothing after the limit is claimed or read.
    assert.deepEqual(
      deps.claim.mock.calls.map(([call]) => call.versionId),
      ["first", "limited"],
    );
    assert.equal(summary.deferred, 2);
    assert.equal(summary.rateLimitedUntil, resetAt.toISOString());
    assert.deepEqual(summary.outcomes, { ok: 1, rate_limited: 1 });
  });

  test("without GITHUB_TOKEN the batch still reads, and says so once", async () => {
    const anonymous = (path: string) => ({
      ...okResult(path),
      tokenPresent: false,
    });
    const { deps, recorded } = harness({
      rows: { a: claimed("a"), b: claimed("b"), c: claimed("c") },
      results: {
        a: anonymous("README.md"),
        b: anonymous("README.md"),
        c: anonymous("README.md"),
      },
    });
    await fetchMcpReadmeBatch(
      { versionIds: ["a", "b", "c"], reason: "scheduled" },
      deps,
    );
    const tokenWarnings = logs.warn.mock.calls.filter(([message]) =>
      String(message).includes("GITHUB_TOKEN"),
    );
    assert.equal(tokenWarnings.length, 1);
    assert.equal(recorded[0]?.tokenPresent, false);
    assert.equal(deps.fetchReadme.mock.calls.length, 3);
  });

  test("an error is counted against the version, and a throw is recorded like one", async () => {
    const { deps, writes } = harness({
      rows: {
        flaky: claimed("flaky", { readmeAttempts: 1, readmeStatus: "error" }),
        broken: claimed("broken"),
      },
      results: {
        flaky: {
          status: "error",
          message: "GitHub README request failed 502",
          tokenPresent: true,
        },
      },
    });
    const summary = await fetchMcpReadmeBatch(
      { versionIds: ["flaky", "broken"], reason: "admin" },
      deps,
    );
    assert.equal(writes[0]?.[1].readmeAttempts, 2);
    assert.equal(
      writes[0]?.[1].readmeError,
      "GitHub README request failed 502",
    );
    assert.equal(writes[1]?.[1].readmeStatus, "error");
    assert.equal(writes[1]?.[1].readmeError, "unexpected fetch for broken");
    assert.deepEqual(summary.outcomes, { error: 2 });
    assert.equal(summary.reason, "admin");
  });
});
