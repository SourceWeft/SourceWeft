import { beforeEach, describe, expect, test, vi } from "vitest";

// The pass without PostgreSQL: the batch it reads and the rows it writes are
// stubbed, so what is under test is how it spends — and stops spending —
// GitHub's request budget. The database-lane suite covers the rows.
const rows: Array<{
  repoOwner: string;
  repoName: string;
  etag: string | null;
  defaultBranch: string | null;
}> = [];
const updates: Array<Record<string, unknown>> = [];

vi.mock("@sourceweft/db", () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: async () => rows,
  };
  return {
    db: {
      execute: vi.fn(async () => undefined),
      select: () => selectChain,
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: async () => undefined };
        },
      }),
    },
    skillDefinitions: {},
    skillRepositories: {},
  };
});
vi.mock("../../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = vi.mocked(await import("../../../shared/logger"), true);
const { refreshSkillRepositoryMetadata } = await import("./repo-metadata");
const { GitHubRateLimitedError } = await import("../../market/parser/github");

const resetEpoch = 1_800_000_000;
const resetAt = new Date(resetEpoch * 1000).toISOString();

function repository(name: string) {
  return { repoOwner: "acme", repoName: name, etag: null, defaultBranch: null };
}

function github(
  status: number,
  body: unknown,
  headers: Record<string, string>,
): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const budget = (remaining: number, limit = 5000) => ({
  "x-ratelimit-limit": String(limit),
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(resetEpoch),
});

const rateLimitWarnings = () =>
  logger.warn.mock.calls.filter(([message]) =>
    String(message).includes("GitHub rate limit reached"),
  );

describe("refreshSkillRepositoryMetadata and GitHub's request budget", () => {
  beforeEach(() => {
    rows.length = 0;
    updates.length = 0;
    vi.clearAllMocks();
  });

  test("keeps asking while the remaining budget is above the reserve", async () => {
    rows.push(repository("one"), repository("two"), repository("three"));
    const fetch = vi.fn(async () =>
      github(200, { id: 1, stargazers_count: 3 }, budget(4_000)),
    );
    const result = await refreshSkillRepositoryMetadata({ deps: { fetch } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      refreshed: 3,
      notModified: 0,
      missing: 0,
      failed: 0,
    });
    expect(rateLimitWarnings()).toHaveLength(0);
  });

  test("stops the pass once the remaining budget drops below the reserve", async () => {
    rows.push(repository("one"), repository("two"), repository("three"));
    const fetch = vi.fn(async () =>
      github(200, { id: 1, stargazers_count: 3 }, budget(50)),
    );
    const result = await refreshSkillRepositoryMetadata({ deps: { fetch } });
    // The answer that reported the low budget is still kept — it was paid for.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      refreshed: 1,
      notModified: 0,
      missing: 0,
      failed: 0,
      rateLimitedUntil: resetAt,
    });
    expect(updates.filter((u) => "stars" in u)).toHaveLength(1);
    expect(rateLimitWarnings()).toHaveLength(1);
    expect(rateLimitWarnings()[0]?.[1]).toMatchObject({
      limit: 5000,
      remaining: 50,
      resetAt,
      refreshed: 1,
    });
  });

  test("a 304 that reports a low budget stops the pass the same way", async () => {
    rows.push(repository("one"), repository("two"));
    const fetch = vi.fn(async () => github(304, null, budget(99)));
    const result = await refreshSkillRepositoryMetadata({ deps: { fetch } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ notModified: 1, rateLimitedUntil: resetAt });
  });

  test("a spent limit answered by the fetch reports the ceiling and reset", async () => {
    rows.push(repository("one"), repository("two"));
    const fetch = vi.fn(async () =>
      github(403, { message: "API rate limit exceeded" }, budget(0, 60)),
    );
    const result = await refreshSkillRepositoryMetadata({ deps: { fetch } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ refreshed: 0, rateLimitedUntil: resetAt });
    expect(rateLimitWarnings()[0]?.[1]).toMatchObject({
      limit: 60,
      remaining: 0,
      resetAt,
    });
  });

  test("a spent limit raised by githubFetch carries the ceiling it saw", async () => {
    rows.push(repository("one"), repository("two"));
    const fetch = vi.fn(async () => {
      throw new GitHubRateLimitedError(
        new Date(resetAt),
        "https://api.github.com/repos/acme/one",
        { limit: 60, remaining: 0 },
      );
    });
    const result = await refreshSkillRepositoryMetadata({ deps: { fetch } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ rateLimitedUntil: resetAt });
    expect(rateLimitWarnings()[0]?.[1]).toMatchObject({
      limit: 60,
      remaining: 0,
      resetAt,
    });
  });
});
