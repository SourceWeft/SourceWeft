// @vitest-environment jsdom

import { createElement, act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResearchRun } from "@sourceweft/contracts/source-research";

const getResearch = vi.hoisted(() => vi.fn());
const cancelResearch = vi.hoisted(() => vi.fn());
vi.mock("../../../../../../lib/sdk", () => ({
  contentClient: { getResearch, cancelResearch },
}));

import { useResearchRun } from "./use-research-run";
import { mountWithIntl, unmountAll } from "@/test/react";

function run(status: ResearchRun["status"]): ResearchRun {
  return {
    id: "r1",
    topic: "t",
    status,
    phase: "searching",
    progress: { round: 0, searches: 0, pagesRead: 0, modelCalls: 0 },
    plan: null,
    report: null,
    citations: [],
    sources: [],
    errorCode: null,
    createdAt: "",
    finishedAt: null,
  };
}

let latest: ReturnType<typeof useResearchRun>;
function Probe({ runId }: { runId: string | null }) {
  latest = useResearchRun("w1", runId);
  return null;
}

beforeEach(() => {
  getResearch.mockReset();
  cancelResearch.mockReset();
  vi.useFakeTimers();
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

const tick = (ms: number) =>
  act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

test("polls every 3 seconds while running and stops at a terminal state", async () => {
  getResearch
    .mockResolvedValueOnce({ run: run("running") })
    .mockResolvedValueOnce({ run: run("running") })
    .mockResolvedValue({ run: run("ready") });
  await mountWithIntl(createElement(Probe, { runId: "r1" }));
  await tick(0);
  expect(getResearch).toHaveBeenCalledTimes(1);
  await tick(2999);
  expect(getResearch).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(getResearch).toHaveBeenCalledTimes(2);
  await tick(3000);
  expect(getResearch).toHaveBeenCalledTimes(3);
  expect(latest.run?.status).toBe("ready");
  await tick(10000);
  expect(getResearch).toHaveBeenCalledTimes(3);
});

test("does nothing without a run id", async () => {
  await mountWithIntl(createElement(Probe, { runId: null }));
  await tick(10000);
  expect(getResearch).not.toHaveBeenCalled();
  expect(latest.run).toBeNull();
});

test("cancel calls the SDK and refreshes the run", async () => {
  getResearch
    .mockResolvedValueOnce({ run: run("running") })
    .mockResolvedValue({ run: run("cancelled") });
  cancelResearch.mockResolvedValue({ cancelled: true });
  await mountWithIntl(createElement(Probe, { runId: "r1" }));
  await tick(0);
  await act(async () => {
    await latest.cancel();
  });
  expect(cancelResearch).toHaveBeenCalledWith("w1", "r1");
  expect(latest.run?.status).toBe("cancelled");
});

test("a failed poll sets error and keeps polling", async () => {
  getResearch
    .mockRejectedValueOnce(new Error("net"))
    .mockResolvedValue({ run: run("running") });
  await mountWithIntl(createElement(Probe, { runId: "r1" }));
  await tick(0);
  expect(latest.error).toBe("net");
  await tick(3000);
  expect(latest.error).toBeNull();
});
