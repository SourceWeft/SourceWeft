import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The schedule's steps are seams: each is a module import stubbed here, so
// the test reads which GitHub-backed steps a tick runs and which it skips.
vi.mock("../../modules/skills/registry/install-references", () => ({
  reconcileSkillInstallReferences: vi.fn(async () => undefined),
}));
vi.mock("../../modules/skills/market/auto-list", () => ({
  runSkillAutoListing: vi.fn(async () => ({
    listed: 0,
    failed: 0,
    backfilled: 0,
  })),
}));
vi.mock("../../modules/skills/market/install-counts", () => ({
  refreshSkillInstallCounts: vi.fn(async () => undefined),
}));
vi.mock("../../modules/skills/market/overviews", () => ({
  enqueueSkillOverviews: vi.fn(async () => undefined),
}));
vi.mock("../../modules/skills/market/provenance", () => ({
  runProvenanceSweep: vi.fn(async () => ({
    confirmed: 0,
    foreign: 0,
    unknown: 0,
  })),
}));
vi.mock("../../modules/skills/market/repo-metadata", () => ({
  refreshSkillRepositoryMetadata: vi.fn(async () => ({
    refreshed: 0,
    notModified: 0,
    missing: 0,
    failed: 0,
  })),
}));
vi.mock("../../modules/skills/market/reviews", () => ({
  refreshSkillRatings: vi.fn(async () => undefined),
}));
vi.mock("../../modules/skills/market/run-stats", () => ({
  refreshSkillRunStats: vi.fn(async () => undefined),
}));
vi.mock("../../shared/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { runProvenanceSweep } = vi.mocked(
  await import("../../modules/skills/market/provenance"),
);
const { refreshSkillRepositoryMetadata } = vi.mocked(
  await import("../../modules/skills/market/repo-metadata"),
);
const { refreshSkillRatings } = vi.mocked(
  await import("../../modules/skills/market/reviews"),
);
const { logger } = vi.mocked(await import("../../shared/logger"), true);
const {
  scheduleSkillMarketUpkeep,
  resetSkillMarketGitHubPause,
  SKILL_MARKET_INTERVAL_MS,
} = await import("./skill-market");

const T0 = new Date("2026-10-12T10:00:00.000Z");

const pauseLines = () =>
  logger.info.mock.calls.filter(([message]) =>
    String(message).startsWith("Skill market GitHub passes paused until"),
  );

describe("scheduleSkillMarketUpkeep under GitHub's rate limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetSkillMarketGitHubPause();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a rate-limited metadata pass pauses both GitHub passes until the reset", async () => {
    const resetAt = new Date(T0.getTime() + 40 * 60_000);
    refreshSkillRepositoryMetadata.mockResolvedValueOnce({
      refreshed: 0,
      notModified: 0,
      missing: 0,
      failed: 0,
      rateLimitedUntil: resetAt.toISOString(),
    });

    await scheduleSkillMarketUpkeep();
    expect(runProvenanceSweep).toHaveBeenCalledTimes(1);
    expect(refreshSkillRepositoryMetadata).toHaveBeenCalledTimes(1);

    // The next ticks before the reset ask GitHub nothing, and say so once.
    vi.setSystemTime(T0.getTime() + SKILL_MARKET_INTERVAL_MS);
    await scheduleSkillMarketUpkeep();
    vi.setSystemTime(T0.getTime() + 2 * SKILL_MARKET_INTERVAL_MS);
    await scheduleSkillMarketUpkeep();
    expect(runProvenanceSweep).toHaveBeenCalledTimes(1);
    expect(refreshSkillRepositoryMetadata).toHaveBeenCalledTimes(1);
    expect(pauseLines()).toHaveLength(1);
    expect(pauseLines()[0]?.[1]).toMatchObject({
      until: resetAt.toISOString(),
    });
    // The rest of the upkeep is not GitHub's and keeps running.
    expect(refreshSkillRatings).toHaveBeenCalledTimes(3);

    // The first tick after the reset asks again.
    vi.setSystemTime(resetAt.getTime() + 1_000);
    await scheduleSkillMarketUpkeep();
    expect(runProvenanceSweep).toHaveBeenCalledTimes(2);
    expect(refreshSkillRepositoryMetadata).toHaveBeenCalledTimes(2);
    expect(pauseLines()).toHaveLength(1);
  });

  test("a rate-limited provenance sweep pauses the metadata pass too", async () => {
    const resetAt = new Date(T0.getTime() + 30 * 60_000);
    runProvenanceSweep.mockResolvedValueOnce({
      confirmed: 0,
      foreign: 0,
      unknown: 0,
      rateLimitedUntil: resetAt.toISOString(),
    });

    await scheduleSkillMarketUpkeep();
    // The limit is the token's, shared by both passes: once provenance has
    // met it, the metadata pass in the same tick is not sent to meet it too.
    expect(refreshSkillRepositoryMetadata).toHaveBeenCalledTimes(0);

    vi.setSystemTime(T0.getTime() + SKILL_MARKET_INTERVAL_MS);
    await scheduleSkillMarketUpkeep();
    expect(runProvenanceSweep).toHaveBeenCalledTimes(1);
    expect(refreshSkillRepositoryMetadata).toHaveBeenCalledTimes(0);
    expect(pauseLines()).toHaveLength(1);

    vi.setSystemTime(resetAt.getTime() + 1_000);
    await scheduleSkillMarketUpkeep();
    expect(runProvenanceSweep).toHaveBeenCalledTimes(2);
    expect(refreshSkillRepositoryMetadata).toHaveBeenCalledTimes(1);
  });

  test("a pass that is not rate limited leaves the next tick free to ask", async () => {
    await scheduleSkillMarketUpkeep();
    vi.setSystemTime(T0.getTime() + SKILL_MARKET_INTERVAL_MS);
    await scheduleSkillMarketUpkeep();
    expect(runProvenanceSweep).toHaveBeenCalledTimes(2);
    expect(refreshSkillRepositoryMetadata).toHaveBeenCalledTimes(2);
    expect(pauseLines()).toHaveLength(0);
  });
});
