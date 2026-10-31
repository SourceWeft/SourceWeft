import { afterEach, expect, test, vi } from "vitest";
import { config } from "./config";
import {
  assertMarketAiWindow,
  MarketAiDeferredError,
  marketAiDeferral,
  nextMarketAiWindow,
} from "./market-ai-schedule";

const original = config.market.aiOffPeakOnly;
afterEach(() => {
  config.market.aiOffPeakOnly = original;
  vi.useRealTimers();
});

test.each([
  ["2026-10-28T00:59:59.999Z", null],
  ["2026-10-28T01:00:00.000Z", "2026-10-28T04:00:00.000Z"],
  ["2026-10-28T03:59:59.999Z", "2026-10-28T04:00:00.000Z"],
  ["2026-10-28T04:00:00.000Z", null],
  ["2026-10-28T05:59:59.999Z", null],
  ["2026-10-28T06:00:00.000Z", "2026-10-28T10:00:00.000Z"],
  ["2026-10-28T09:59:59.999Z", "2026-10-28T10:00:00.000Z"],
  ["2026-10-28T10:00:00.000Z", null],
  ["2026-10-31T01:00:00.000Z", null],
  ["2026-11-01T06:00:00.000Z", null],
  // UTC is Sunday, Beijing is already Monday: do not use the host's weekday.
  ["2026-11-01T17:00:00.000Z", null],
  ["2026-11-02T01:00:00.000Z", "2026-11-02T04:00:00.000Z"],
])("Beijing peak boundary %s", (time, expected) => {
  expect(nextMarketAiWindow(new Date(time), true)?.toISOString() ?? null).toBe(
    expected,
  );
});

test("opt-out permits peak hours; opt-in returns a typed deferral with the resume time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T01:05:00Z"));
  config.market.aiOffPeakOnly = false;
  expect(() => assertMarketAiWindow()).not.toThrow();
  config.market.aiOffPeakOnly = true;
  expect(() => assertMarketAiWindow()).toThrow(MarketAiDeferredError);
  expect(nextMarketAiWindow()?.toISOString()).toBe("2026-10-28T04:00:00.000Z");
});

test("recovers wrapped deferrals and terminates on unrelated or cyclic errors", () => {
  const deferred = new MarketAiDeferredError(new Date("2026-10-28T04:00Z"));
  expect(
    marketAiDeferral(
      new Error("SDK", { cause: new Error("gateway", { cause: deferred }) }),
    ),
  ).toBe(deferred);
  const cyclic = new Error("unrelated");
  cyclic.cause = cyclic;
  expect(marketAiDeferral(cyclic)).toBeNull();
  expect(marketAiDeferral(null)).toBeNull();
});
