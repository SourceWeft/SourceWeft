import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../../modules/market/federation", () => ({
  runMarketFederation: mocks.run,
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: mocks.info, warn: vi.fn(), error: vi.fn() },
}));

import { scheduleMarketFederation } from "./market-federation";

afterEach(() => {
  vi.clearAllMocks();
});

test("an interval that fires during a running sync is skipped, and the next one runs", async () => {
  let finish!: () => void;
  mocks.run.mockReturnValueOnce(
    new Promise<unknown[]>((resolve) => {
      finish = () => resolve([]);
    }),
  );
  const first = scheduleMarketFederation();
  // The timer fires again while the first walk is still going.
  assert.equal(await scheduleMarketFederation(), false);
  assert.equal(mocks.run.mock.calls.length, 1);
  assert.ok(
    mocks.info.mock.calls.some(([message]) =>
      String(message).includes("skipping this interval"),
    ),
  );

  finish();
  assert.equal(await first, true);

  mocks.run.mockResolvedValueOnce([]);
  assert.equal(await scheduleMarketFederation(), true);
  assert.equal(mocks.run.mock.calls.length, 2);
});

test("a sync that throws releases the guard", async () => {
  mocks.run.mockRejectedValueOnce(new Error("registry down"));
  await assert.rejects(scheduleMarketFederation(), /registry down/);
  mocks.run.mockResolvedValueOnce([]);
  assert.equal(await scheduleMarketFederation(), true);
});
