import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runPass: vi.fn(),
  trigger: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../modules/connectors", () => ({
  connectorPersonalDataService: { runPass: mocks.runPass },
}));
vi.mock("../../modules/ops", () => ({
  opsAlertService: { trigger: mocks.trigger },
}));
vi.mock("../../shared/logger", () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
    error: mocks.error,
    debug: vi.fn(),
  },
}));

import {
  PERSONAL_DATA_PASS_INTERVAL_MS,
  runConnectorPersonalDataPass,
} from "./connector-personal-data";

function summary(overrides: Record<string, number> = {}) {
  return {
    types: 1,
    checked: 3,
    reported: 3,
    closed: 0,
    updated: 0,
    scrubbed: 0,
    ignored: 0,
    failed: 0,
    skippedNoBearer: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runPass.mockResolvedValue(summary());
  mocks.trigger.mockResolvedValue({ skipped: true });
});

it("runs every six hours", () => {
  expect(PERSONAL_DATA_PASS_INTERVAL_MS).toBe(6 * 60 * 60_000);
});

it("does not start a second pass while one is still running", async () => {
  let finish!: () => void;
  mocks.runPass.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = () => resolve(summary());
    }),
  );
  const first = runConnectorPersonalDataPass(
    new Date("2026-11-20T00:00:00.000Z"),
  );
  await runConnectorPersonalDataPass(new Date("2026-11-20T01:00:00.000Z"));
  expect(mocks.runPass).toHaveBeenCalledTimes(1);
  finish();
  await first;
  await runConnectorPersonalDataPass(new Date("2026-11-20T06:00:00.000Z"));
  expect(mocks.runPass).toHaveBeenCalledTimes(2);
  expect(mocks.runPass).toHaveBeenLastCalledWith({
    now: new Date("2026-11-20T06:00:00.000Z"),
  });
});

it("never rejects, logs a failed pass once, and runs again afterwards", async () => {
  mocks.runPass.mockRejectedValueOnce(new Error("db down"));
  await expect(
    runConnectorPersonalDataPass(new Date("2026-11-20T00:00:00.000Z")),
  ).resolves.toBeUndefined();
  expect(mocks.error).toHaveBeenCalledTimes(1);
  expect(mocks.error).toHaveBeenCalledWith(
    "Failed to run connector personal data pass",
    { message: "db down" },
  );
  await runConnectorPersonalDataPass(new Date("2026-11-20T06:00:00.000Z"));
  expect(mocks.runPass).toHaveBeenCalledTimes(2);
});

it("raises no alert for a clean pass", async () => {
  await runConnectorPersonalDataPass();
  expect(mocks.trigger).not.toHaveBeenCalled();
});

it("raises no alert for closed, updated, scrubbed or ignored accounts alone", async () => {
  mocks.runPass.mockResolvedValue(
    summary({ closed: 2, updated: 1, scrubbed: 1, ignored: 4 }),
  );
  await runConnectorPersonalDataPass();
  expect(mocks.trigger).not.toHaveBeenCalled();
});

it.each([
  [{ failed: 2, skippedNoBearer: 0 }],
  [{ failed: 0, skippedNoBearer: 3 }],
  [{ failed: 1, skippedNoBearer: 1 }],
])("raises one alert with counts only for %j", async (counts) => {
  mocks.runPass.mockResolvedValue(summary(counts));
  await runConnectorPersonalDataPass();
  expect(mocks.trigger).toHaveBeenCalledTimes(1);
  const input = mocks.trigger.mock.calls[0]![0];
  expect(input).toMatchObject({
    alertKey: "scheduler:connector-personal-data:failure",
    level: "error",
    source: "scheduler",
    metadata: counts,
  });
  expect(Object.keys(input.metadata).sort()).toEqual([
    "failed",
    "skippedNoBearer",
  ]);
});

it("keeps the alert stable and free of provider text", async () => {
  mocks.runPass.mockResolvedValue(summary({ failed: 1 }));
  await runConnectorPersonalDataPass();
  const input = mocks.trigger.mock.calls[0]![0];
  expect(input.message).toBe("1 failed, 0 skipped for lack of a bearer");
});

it("still resolves and logs when raising the alert fails", async () => {
  mocks.runPass.mockResolvedValue(summary({ failed: 1 }));
  mocks.trigger.mockRejectedValueOnce(new Error("ops down"));
  await expect(runConnectorPersonalDataPass()).resolves.toBeUndefined();
  expect(mocks.error).toHaveBeenCalledTimes(1);
  expect(mocks.error).toHaveBeenCalledWith(
    "Failed to emit connector personal data alert",
    { message: "ops down" },
  );
});
