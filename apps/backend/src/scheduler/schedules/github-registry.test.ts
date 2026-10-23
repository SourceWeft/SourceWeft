import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../shared/logger", () => ({
  logger: { warn: logs.warn, info: logs.info, debug: vi.fn(), error: vi.fn() },
}));

import type { GithubRegistryPassSummary } from "../../modules/market/github-registry/state";
import {
  GITHUB_REGISTRY_PASS_INTERVAL_MS,
  GITHUB_REGISTRY_TICK_INTERVAL_MS,
  githubRegistryPassDue,
  scheduleGithubRegistryEnrichment,
} from "./github-registry";

const NOW = new Date("2026-10-24T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function pass(
  finishedAt: Date,
  overrides: Partial<GithubRegistryPassSummary> = {},
) {
  return {
    startedAt: new Date(finishedAt.getTime() - 60_000).toISOString(),
    finishedAt: finishedAt.toISOString(),
    pages: 7,
    rows: 604,
    stoppedBy: null,
    targets: 3000,
    matched: { name: 570, endpointDomainOrg: 11 },
    written: 581,
    manifestPatched: 40,
    failed: 0,
    ...overrides,
  } satisfies GithubRegistryPassSummary;
}

function deps(last: GithubRegistryPassSummary | null | Error) {
  const run = vi.fn(async () => pass(NOW));
  return {
    deps: {
      readLastPass: async () => {
        if (last instanceof Error) throw last;
        return last;
      },
      run,
      now: () => NOW,
    },
    run,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("the pace is one pass a day, checked hourly", () => {
  assert.equal(GITHUB_REGISTRY_PASS_INTERVAL_MS, 24 * HOUR);
  assert.equal(GITHUB_REGISTRY_TICK_INTERVAL_MS, HOUR);
});

test("a pass is due with no record, a day after the last, or after one that read nothing", async () => {
  assert.equal(await githubRegistryPassDue(deps(null).deps), true);
  assert.equal(
    await githubRegistryPassDue(
      deps(pass(new Date(NOW.getTime() - 25 * HOUR))).deps,
    ),
    true,
  );
  assert.equal(
    await githubRegistryPassDue(
      deps(pass(new Date(NOW.getTime() - 24 * HOUR))).deps,
    ),
    true,
  );
  assert.equal(
    await githubRegistryPassDue(
      deps(
        pass(new Date(NOW.getTime() - HOUR), { rows: 0, stoppedBy: "error" }),
      ).deps,
    ),
    true,
  );
  // An unreadable marker: run, and write it again after.
  assert.equal(
    await githubRegistryPassDue(deps(new Error("redis away")).deps),
    true,
  );
  assert.equal(logs.warn.mock.calls.length, 1);
});

test("a pass is not due within a day of one that read rows, even one that stopped early", async () => {
  assert.equal(
    await githubRegistryPassDue(
      deps(pass(new Date(NOW.getTime() - HOUR))).deps,
    ),
    false,
  );
  assert.equal(
    await githubRegistryPassDue(
      deps(
        pass(new Date(NOW.getTime() - 23 * HOUR), {
          rows: 200,
          stoppedBy: "rate_limited",
        }),
      ).deps,
    ),
    false,
  );
});

test("the schedule runs a pass only when one is due", async () => {
  const due = deps(null);
  const ran = await scheduleGithubRegistryEnrichment(due.deps);
  assert.equal(ran.ran, true);
  assert.equal(ran.summary?.rows, 604);
  assert.equal(due.run.mock.calls.length, 1);

  const notDue = deps(pass(new Date(NOW.getTime() - HOUR)));
  assert.deepEqual(await scheduleGithubRegistryEnrichment(notDue.deps), {
    ran: false,
  });
  assert.equal(notDue.run.mock.calls.length, 0);
});
