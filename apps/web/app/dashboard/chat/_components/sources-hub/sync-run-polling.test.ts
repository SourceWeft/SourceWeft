import { describe, expect, it } from "vitest";
import {
  ACTIVE_SYNC_RUN_POLL_MS,
  type ActiveConnectorSyncRun,
  HIDDEN_SYNC_RUN_POLL_MS,
  IDLE_SYNC_RUN_POLL_MS,
  MAX_SYNC_RUN_ERROR_POLL_MS,
  SOURCE_SYNC_UPDATED_AFTER_OVERLAP_MS,
  SYNC_RUN_COOLDOWN_POLL_MS,
  getConnectorSyncRunErrorDelay,
  getConnectorSyncRunPollDecision,
  getIncrementalUpdatedAfter,
  planConnectorSyncRunResult,
  selectConnectorSyncRunLeader,
} from "./sync-run-polling";

function tracked(
  overrides: Partial<ActiveConnectorSyncRun> & { connectorId: string },
): ActiveConnectorSyncRun {
  return {
    discoveredCount: 0,
    indexedCount: 0,
    failedCount: 0,
    lastSourceUpdatedAt: null,
    hasFinalRefreshed: false,
    ...overrides,
  };
}

function run(
  id: string,
  connectorId: string | null,
  counts: Partial<
    Pick<
      ActiveConnectorSyncRun,
      "discoveredCount" | "indexedCount" | "failedCount"
    >
  > = {},
) {
  return {
    id,
    connectorId,
    discoveredCount: 0,
    indexedCount: 0,
    failedCount: 0,
    ...counts,
  };
}

describe("connector sync run polling", () => {
  it("uses active cadence while active runs are known", () => {
    expect(
      getConnectorSyncRunPollDecision({
        errorCount: 0,
        hasActiveRuns: true,
        isVisible: true,
        needsCooldownConfirmation: false,
      }),
    ).toEqual({ delayMs: ACTIVE_SYNC_RUN_POLL_MS, mode: "active" });
  });

  it("uses one cooldown confirmation before returning to idle", () => {
    expect(
      getConnectorSyncRunPollDecision({
        errorCount: 0,
        hasActiveRuns: false,
        isVisible: true,
        needsCooldownConfirmation: true,
      }),
    ).toEqual({ delayMs: SYNC_RUN_COOLDOWN_POLL_MS, mode: "cooldown" });
  });

  it("falls back to idle cadence when no work is active", () => {
    expect(
      getConnectorSyncRunPollDecision({
        errorCount: 0,
        hasActiveRuns: false,
        isVisible: true,
        needsCooldownConfirmation: false,
      }),
    ).toEqual({ delayMs: IDLE_SYNC_RUN_POLL_MS, mode: "idle" });
  });

  it("slows polling while hidden", () => {
    expect(
      getConnectorSyncRunPollDecision({
        errorCount: 0,
        hasActiveRuns: true,
        isVisible: false,
        needsCooldownConfirmation: false,
      }),
    ).toEqual({ delayMs: HIDDEN_SYNC_RUN_POLL_MS, mode: "hidden" });
  });

  it("backs off failed requests", () => {
    expect(getConnectorSyncRunErrorDelay(1)).toBe(5000);
    expect(getConnectorSyncRunErrorDelay(2)).toBe(10000);
    expect(getConnectorSyncRunErrorDelay(3)).toBe(
      MAX_SYNC_RUN_ERROR_POLL_MS,
    );
  });

  it("selects the lowest visible non-stale tab as leader", () => {
    expect(
      selectConnectorSyncRunLeader(
        [
          { id: "tab-c", lastSeenAt: 10_000, visible: true },
          { id: "tab-a", lastSeenAt: 10_000, visible: true },
          { id: "tab-b", lastSeenAt: 10_000, visible: false },
        ],
        12_000,
      ),
    ).toBe("tab-a");
  });

  it("ignores stale leader candidates", () => {
    expect(
      selectConnectorSyncRunLeader(
        [
          { id: "tab-a", lastSeenAt: 1_000, visible: true },
          { id: "tab-b", lastSeenAt: 10_000, visible: true },
        ],
        12_000,
      ),
    ).toBe("tab-b");
  });
});

describe("getIncrementalUpdatedAfter", () => {
  it("returns undefined when there is no watermark", () => {
    expect(getIncrementalUpdatedAfter(null)).toBeUndefined();
  });

  it("subtracts the overlap window from a valid timestamp", () => {
    const at = "2024-01-01T00:00:10.000Z";
    expect(getIncrementalUpdatedAfter(at)).toBe(
      new Date(
        Date.parse(at) - SOURCE_SYNC_UPDATED_AFTER_OVERLAP_MS,
      ).toISOString(),
    );
  });

  it("passes through an unparseable value unchanged", () => {
    expect(getIncrementalUpdatedAfter("not-a-date")).toBe("not-a-date");
  });
});

describe("planConnectorSyncRunResult", () => {
  it("registers a new active run and requests a first incremental fetch", () => {
    const plan = planConnectorSyncRunResult(
      [run("r1", "c1", { discoveredCount: 3 })],
      new Map(),
    );
    expect(plan.nextTracked.get("r1")).toMatchObject({
      connectorId: "c1",
      discoveredCount: 3,
    });
    expect(plan.incrementalTargets).toEqual([
      { runId: "r1", connectorId: "c1", updatedAfter: undefined },
    ]);
    expect(plan.completedRunIds).toEqual([]);
    expect(plan.needsCooldownConfirmation).toBe(false);
  });

  it("skips runs with unchanged counts once a watermark exists", () => {
    const plan = planConnectorSyncRunResult(
      [run("r1", "c1", { discoveredCount: 3 })],
      new Map([
        [
          "r1",
          tracked({
            connectorId: "c1",
            discoveredCount: 3,
            lastSourceUpdatedAt: "2024-01-01T00:00:00.000Z",
          }),
        ],
      ]),
    );
    expect(plan.incrementalTargets).toEqual([]);
  });

  it("re-fetches (with overlap) when counts change", () => {
    const plan = planConnectorSyncRunResult(
      [run("r1", "c1", { indexedCount: 5 })],
      new Map([
        [
          "r1",
          tracked({
            connectorId: "c1",
            indexedCount: 2,
            lastSourceUpdatedAt: "2024-01-01T00:00:10.000Z",
          }),
        ],
      ]),
    );
    expect(plan.incrementalTargets).toEqual([
      {
        runId: "r1",
        connectorId: "c1",
        updatedAfter: getIncrementalUpdatedAfter("2024-01-01T00:00:10.000Z"),
      },
    ]);
  });

  it("ignores runs without a connector id", () => {
    const plan = planConnectorSyncRunResult([run("r1", null)], new Map());
    expect(plan.nextTracked.size).toBe(0);
    expect(plan.incrementalTargets).toEqual([]);
  });

  it("finalises a completed run and marks its connector for a full refresh", () => {
    const plan = planConnectorSyncRunResult(
      [],
      new Map([["r1", tracked({ connectorId: "c1" })]]),
    );
    expect(plan.completedRunIds).toEqual(["r1"]);
    expect(plan.finalRefreshConnectorIds).toEqual(["c1"]);
    expect(plan.needsCooldownConfirmation).toBe(true);
  });

  it("does not final-refresh a connector that still has an active run", () => {
    const plan = planConnectorSyncRunResult(
      [run("r2", "c1")],
      new Map([
        ["r1", tracked({ connectorId: "c1" })],
        ["r2", tracked({ connectorId: "c1" })],
      ]),
    );
    expect(plan.completedRunIds).toEqual(["r1"]);
    expect(plan.finalRefreshConnectorIds).toEqual([]);
    // Non-empty poll result never triggers cooldown confirmation.
    expect(plan.needsCooldownConfirmation).toBe(false);
  });

  it("excludes already-finalised runs from completion", () => {
    const plan = planConnectorSyncRunResult(
      [],
      new Map([
        ["r1", tracked({ connectorId: "c1", hasFinalRefreshed: true })],
      ]),
    );
    expect(plan.completedRunIds).toEqual([]);
    expect(plan.needsCooldownConfirmation).toBe(false);
  });
});
