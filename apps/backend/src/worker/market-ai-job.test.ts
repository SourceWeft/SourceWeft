import { DelayedError, type Job } from "bullmq";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { config } from "../shared/config";
import { MarketAiDeferredError } from "../shared/market-ai-schedule";
import { runMarketAiJob } from "./market-ai-job";

const original = config.market.aiOffPeakOnly;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T01:00Z"));
  config.market.aiOffPeakOnly = true;
});
afterEach(() => {
  config.market.aiOffPeakOnly = original;
  vi.useRealTimers();
});
function job(name: string) {
  return {
    id: "job",
    name,
    data: {},
    token: "lock",
    attemptsMade: 2,
    moveToDelayed: vi.fn(async () => {}),
  } as unknown as Job<Record<string, unknown>>;
}

test.each([
  "mcp-overview-generate",
  "skill-overview-generate",
  "mcp-summary-translation",
])("defers %s without running or consuming its last retry", async (name) => {
  const active = job(name),
    process = vi.fn();
  await expect(runMarketAiJob(active, process)).rejects.toBeInstanceOf(
    DelayedError,
  );
  expect(active.moveToDelayed).toHaveBeenCalledWith(
    Date.parse("2026-10-28T04:00Z"),
    "lock",
  );
  expect(process).not.toHaveBeenCalled();
  expect(active.attemptsMade).toBe(2);
});
test("tenant jobs keep running in peak hours", async () => {
  const active = job("thread-chat-run"),
    process = vi.fn(async () => "done");
  expect(await runMarketAiJob(active, process)).toBe("done");
  expect(active.moveToDelayed).not.toHaveBeenCalled();
});
test("a resumed retry runs normally when the valley opens", async () => {
  const active = job("mcp-overview-generate"),
    process = vi.fn(async () => "done");
  await expect(runMarketAiJob(active, process)).rejects.toBeInstanceOf(
    DelayedError,
  );
  vi.setSystemTime(new Date("2026-10-28T04:00Z"));
  expect(await runMarketAiJob(active, process)).toBe("done");
  expect(active.attemptsMade).toBe(2);
});
test("a translation pass or overview crossing into peak hours is deferred", async () => {
  vi.setSystemTime(new Date("2026-10-28T00:59Z"));
  const active = job("mcp-summary-translation");
  await expect(
    runMarketAiJob(active, async () => {
      throw new MarketAiDeferredError(new Date("2026-10-28T04:00Z"));
    }),
  ).rejects.toBeInstanceOf(DelayedError);
  expect(active.moveToDelayed).toHaveBeenCalledOnce();
});
test("opt-out runs market jobs normally and provider failures retain normal retries", async () => {
  config.market.aiOffPeakOnly = false;
  const active = job("mcp-overview-generate"),
    error = new Error("provider failure");
  await expect(
    runMarketAiJob(active, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(active.moveToDelayed).not.toHaveBeenCalled();
});
