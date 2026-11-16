import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshIdleAccounts: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Only `refreshIdleConnectorTokens` is under test here; the rest of this
// module's imports are stubbed just so it loads.
vi.mock("../../modules/connectors", () => ({
  connectorOAuthService: { refreshIdleAccounts: mocks.refreshIdleAccounts },
  connectorSyncOrchestrator: {
    enqueueQuotaResumeRun: vi.fn(),
    enqueueScheduledRun: vi.fn(),
  },
}));
vi.mock("../../modules/content/queue", () => ({
  enqueueConnectorSyncJob: vi.fn(),
  getConnectorSyncJobState: vi.fn(),
}));
vi.mock("../../modules/connectors/errors", () => ({
  toConnectorError: vi.fn((error: unknown) => error),
}));
vi.mock("../../modules/connectors/repository", () => ({
  claimDispatchableConnectorOccurrences: vi.fn().mockResolvedValue([]),
  completeScheduleOccurrence: vi.fn(),
  listQueuedConnectorOccurrences: vi.fn().mockResolvedValue([]),
  listStaleRunningConnectorOccurrences: vi.fn().mockResolvedValue([]),
  markScheduleOccurrenceQueued: vi.fn(),
  markScheduleOccurrenceSkipped: vi.fn(),
  materializeDueConnectorSchedules: vi.fn(),
  listQuotaBlockedConnectorRecords: vi.fn().mockResolvedValue([]),
  retryScheduleOccurrence: vi.fn(),
  recoverLostScheduleOccurrence: vi.fn(),
  pauseConnectorScheduleForAuth: vi.fn(),
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error, debug: vi.fn() },
}));

import { refreshIdleConnectorTokens } from "./connectors";

// Alias matching the ruling's test text verbatim.
const refreshIdleAccounts = mocks.refreshIdleAccounts;

beforeEach(() => {
  vi.clearAllMocks();
  refreshIdleAccounts.mockResolvedValue(undefined);
});

it("does not start a second pass while one is still running", async () => {
  let finish!: () => void;
  refreshIdleAccounts.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const first = refreshIdleConnectorTokens(
    new Date("2026-11-15T00:00:00.000Z"),
  );
  await refreshIdleConnectorTokens(new Date("2026-11-15T01:00:00.000Z"));
  expect(refreshIdleAccounts).toHaveBeenCalledTimes(1);
  finish();
  await first;
  await refreshIdleConnectorTokens(new Date("2026-11-15T02:00:00.000Z"));
  expect(refreshIdleAccounts).toHaveBeenCalledTimes(2);
  expect(refreshIdleAccounts).toHaveBeenLastCalledWith({
    now: new Date("2026-11-15T02:00:00.000Z"),
  });
});

it("never rejects and runs again after a failed pass", async () => {
  refreshIdleAccounts.mockRejectedValueOnce(new Error("db down"));
  await expect(
    refreshIdleConnectorTokens(new Date("2026-11-15T00:00:00.000Z")),
  ).resolves.toBeUndefined();
  await refreshIdleConnectorTokens(new Date("2026-11-15T01:00:00.000Z"));
  expect(refreshIdleAccounts).toHaveBeenCalledTimes(2);
  // The failed pass is logged, not swallowed silently or printed raw.
  expect(mocks.error).toHaveBeenCalledTimes(1);
});
