import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["dist/**", "src/**/*.test.ts", "src/**/*.d.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    pool: "forks",
    // Turbo runs workspace suites together. Bound this suite's forks so
    // parallel full-schema migrations do not starve each other or the Web suite.
    // Two-connection races inside a test retain their explicit barriers.
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
  },
});
