import type { ViteUserConfig } from "vitest/config";

export const databaseTestGlob = "src/**/*.database.test.ts";

/**
 * Options common to the unit lane (vitest.config.ts) and the database lane
 * (vitest.database.config.ts). Keep them identical so a test behaves the same
 * whichever lane picks it up.
 */
export const sharedTestOptions = {
  environment: "node",
  passWithNoTests: false,
  pool: "forks",
  // Turbo runs workspace suites together. Bound this suite's forks so it does
  // not starve the Web suite, and so database-lane clones stay within the
  // shared PostgreSQL service's connection budget. Two-connection races
  // inside a test retain their explicit barriers.
  maxWorkers: 2,
  // The default 5s timeout measures wall-clock, which for this fork-parallel,
  // import-heavy suite includes time a test's fork spends starved of CPU. A
  // handful of legitimately heavy tests (whole-tree AST scans, real
  // capability-module discovery, durable-run recovery) run well under 5s
  // alone but exceed it under full-suite contention, and which one loses the
  // race is scheduling-dependent. Raise the ceiling globally rather than
  // patch individual tests as they surface.
  testTimeout: 30_000,
  hookTimeout: 30_000,
  setupFiles: ["src/test/setup.ts"],
} satisfies NonNullable<ViteUserConfig["test"]>;
