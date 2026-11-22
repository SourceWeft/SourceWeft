// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResearchRun } from "@sourceweft/contracts/source-research";

const startResearch = vi.hoisted(() => vi.fn());
const getResearch = vi.hoisted(() => vi.fn());
const cancelResearch = vi.hoisted(() => vi.fn());
const saveResearchNote = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../lib/sdk", () => ({
  contentClient: {
    startResearch,
    getResearch,
    cancelResearch,
    saveResearchNote,
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ResearchDialog } from "./research-dialog";
import { ResearchCard } from "./research-card";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

function run(patch: Partial<ResearchRun> = {}): ResearchRun {
  return {
    id: "r1",
    topic: "solid state batteries",
    status: "running",
    phase: "searching",
    progress: { round: 1, searches: 4, pagesRead: 7, modelCalls: 3 },
    plan: null,
    report: null,
    citations: [],
    sources: [],
    errorCode: null,
    createdAt: "2026-11-22T00:00:00Z",
    finishedAt: null,
    ...patch,
  };
}

beforeEach(() => {
  for (const fn of [
    startResearch,
    getResearch,
    cancelResearch,
    saveResearchNote,
  ])
    fn.mockReset();
});
afterEach(unmountAll);

const text = () => document.body.textContent ?? "";
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(name),
  );

test("running card shows progress counts and cancels the run", async () => {
  cancelResearch.mockResolvedValue({ cancelled: true });
  const onCancel = vi.fn(() => cancelResearch("w1", "r1"));
  await mountWithIntl(createElement(ResearchCard, { run: run(), onCancel }));
  expect(text()).toContain("4 searches");
  expect(text()).toContain("7 pages read");
  await click(buttonNamed("Cancel")!);
  expect(cancelResearch).toHaveBeenCalledWith("w1", "r1");
});

test.each([
  ["WEB_PROVIDER_UNAVAILABLE", "Web search is not available"],
  ["NO_RESULTS", "found no usable pages"],
  ["RESEARCH_QUALITY_TOO_LOW", "not reliable enough"],
  ["INSUFFICIENT_CREDITS", "not have enough credits"],
  ["MODEL_UNAVAILABLE", "model is unavailable"],
  ["TIME_LIMIT", "time limit"],
  ["ACCESS_LOST", "no longer have access"],
] as const)("failed run maps %s to a message", async (code, fragment) => {
  await mountWithIntl(
    createElement(ResearchCard, {
      run: run({ status: "failed", errorCode: code }),
      onCancel: vi.fn(),
    }),
  );
  expect(text()).toContain(fragment);
});

test("dialog starts a run and polls it to a ready report", async () => {
  vi.useFakeTimers();
  try {
    startResearch.mockResolvedValue({ run: run({ status: "queued" }) });
    getResearch.mockResolvedValue({
      run: run({ status: "ready", report: "The report body" }),
    });
    await mountWithIntl(
      createElement(ResearchDialog, {
        onSaved: vi.fn(),
        onOpenChange: () => {},
        open: true,
        workspaceId: "w1",
      }),
    );
    const input = document.body.querySelector("input") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "solid state batteries");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await click(buttonNamed("Start research")!);
    await flush();
    expect(startResearch).toHaveBeenCalledWith("w1", "solid state batteries");
    expect(text()).toContain("The report body");
  } finally {
    vi.useRealTimers();
  }
});
