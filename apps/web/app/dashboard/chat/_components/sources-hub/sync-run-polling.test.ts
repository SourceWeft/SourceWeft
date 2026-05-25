import { describe, expect, it } from "vitest";
import {
  ACTIVE_SYNC_RUN_POLL_MS,
  HIDDEN_SYNC_RUN_POLL_MS,
  IDLE_SYNC_RUN_POLL_MS,
  MAX_SYNC_RUN_ERROR_POLL_MS,
  SYNC_RUN_COOLDOWN_POLL_MS,
  getConnectorSyncRunErrorDelay,
  getConnectorSyncRunPollDecision,
  selectConnectorSyncRunLeader,
} from "./sync-run-polling";

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
