// @vitest-environment jsdom

import { act, createElement } from "react";
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
import {
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
  withIntl,
} from "@/test/react";

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
      run: run({ status: "ready", report: "The **report** body" }),
    });
    await mountWithIntl(
      createElement(ResearchDialog, {
        existingUrls: [],
        onImported: vi.fn(),
        onSaved: vi.fn(),
        onOpenChange: () => {},
        open: true,
        workspaceId: "w1",
      }),
    );
    typeInto(
      document.body.querySelector("input") as HTMLInputElement,
      "solid state batteries",
    );
    await flush();
    await click(buttonNamed("Start research")!);
    await flush();
    expect(startResearch).toHaveBeenCalledWith("w1", "solid state batteries");
    await flush(5);
    expect(text()).toContain("body");
    expect(
      document.body.querySelector('[data-streamdown="strong"]')?.textContent,
    ).toBe("report");
  } finally {
    vi.useRealTimers();
  }
});

test("Enter while composing text does not start a run", async () => {
  await mountWithIntl(
    createElement(ResearchDialog, {
      existingUrls: [],
      onImported: vi.fn(),
      onSaved: vi.fn(),
      onOpenChange: () => {},
      open: true,
      workspaceId: "w1",
    }),
  );
  const input = document.body.querySelector("input") as HTMLInputElement;
  typeInto(input, "电池");
  await flush();
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  expect(startResearch).not.toHaveBeenCalled();
});

test("a saved report stays saved when the dialog is closed and reopened", async () => {
  startResearch.mockResolvedValue({ run: run({ status: "queued" }) });
  getResearch.mockResolvedValue({
    run: run({ status: "ready", report: "Body [1]" }),
  });
  saveResearchNote.mockResolvedValue({
    noteId: "n",
    sourceId: "s",
    title: "t",
    alreadySaved: false,
  });
  const props = {
    existingUrls: [],
    onImported: vi.fn(),
    onSaved: vi.fn(),
    onOpenChange: () => {},
    workspaceId: "w1",
  };
  const mounted = await mountWithIntl(
    createElement(ResearchDialog, { ...props, open: true }),
  );
  typeInto(document.body.querySelector("input")!, "batteries");
  await flush();
  await click(buttonNamed("Start research")!);
  await flush(5);
  await click(buttonNamed("Save report as a note")!);
  await flush(3);
  await mounted.render(
    withIntl(createElement(ResearchDialog, { ...props, open: false })),
  );
  await mounted.render(
    withIntl(createElement(ResearchDialog, { ...props, open: true })),
  );
  await flush(5);
  expect(saveResearchNote).toHaveBeenCalledTimes(1);
  expect(buttonNamed("Save report as a note")).toBeUndefined();
  expect(buttonNamed("Saved")).toBeTruthy();
});
