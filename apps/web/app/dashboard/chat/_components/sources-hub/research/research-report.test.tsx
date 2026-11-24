// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResearchRun } from "@sourceweft/contracts/source-research";

const createUrlSource = vi.hoisted(() => vi.fn());
const listSourceStatuses = vi.hoisted(() => vi.fn());
const saveResearchNote = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../lib/sdk", () => ({
  contentClient: { createUrlSource, listSourceStatuses, saveResearchNote },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ResearchReport } from "./research-report";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

const run: ResearchRun = {
  id: "r1",
  topic: "batteries",
  status: "ready",
  phase: "reporting",
  progress: { round: 1, searches: 4, pagesRead: 7, modelCalls: 3 },
  plan: null,
  report: "Solid state cells are **promising** [1]. Costs are falling [2].",
  citations: [
    { entryId: "e1", quote: "cells are promising", status: "verified" },
    { entryId: "e2", quote: "costs are falling fast", status: "verified" },
  ],
  sources: [
    { url: "https://a.com/1", title: "Batteries explained", entryId: "e1" },
    { url: "https://b.com/2", title: "Market report", entryId: "e2" },
    { url: "https://c.com/3", title: "Old news", entryId: "e3" },
  ],
  errorCode: null,
  createdAt: "2026-11-22T00:00:00Z",
  finishedAt: "2026-11-22T00:05:00Z",
};

beforeEach(() => {
  createUrlSource.mockReset();
  listSourceStatuses.mockReset();
  saveResearchNote.mockReset();
  createUrlSource.mockImplementation(
    async (_w: string, input: { url: string }) => ({
      source: { id: `s-${input.url}` },
      status: {},
    }),
  );
  listSourceStatuses.mockImplementation(
    async (_w: string, input: { ids: string[] }) => ({
      items: input.ids.map((id) => ({
        id,
        status: { status: "indexed", error: null },
      })),
    }),
  );
});
afterEach(unmountAll);

const text = () => document.body.textContent ?? "";
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(name),
  );
const checkbox = (label: string) =>
  document.body.querySelector(
    `[role="checkbox"][aria-label="${label}"]`,
  ) as HTMLElement;

async function mountReport(
  props: Partial<Parameters<typeof ResearchReport>[0]> = {},
) {
  const onSaved = vi.fn();
  const onImported = vi.fn();
  await mountWithIntl(
    createElement(ResearchReport, {
      run,
      workspaceId: "w1",
      existingUrls: [],
      saved: false,
      onSaved,
      onImported,
      ...props,
    }),
  );
  await flush(5);
  return { onSaved, onImported };
}

test("renders the report as markdown and shows a citation's quote and page on hover", async () => {
  await mountReport();
  expect(
    document.body.querySelector('[data-streamdown="strong"]')?.textContent,
  ).toBe("promising");
  const cite = [...document.body.querySelectorAll("a")].find(
    (a) => a.textContent === "[2]",
  )!;
  expect(cite).toBeTruthy();
  cite.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await flush();
  expect(text()).toContain("costs are falling fast");
  expect(text()).toContain("https://b.com/2");
});

test("imports every source by default, one call per page", async () => {
  const { onImported } = await mountReport();
  await click(buttonNamed("Import 3 selected sources")!);
  await flush(10);
  expect(createUrlSource.mock.calls.map((c) => c[1].url).sort()).toEqual([
    "https://a.com/1",
    "https://b.com/2",
    "https://c.com/3",
  ]);
  expect(onImported).toHaveBeenCalled();
});

test("an unchecked source is not imported", async () => {
  await mountReport();
  await click(checkbox("Old news"));
  await click(buttonNamed("Import 2 selected sources")!);
  await flush(10);
  expect(createUrlSource).toHaveBeenCalledTimes(2);
  expect(createUrlSource.mock.calls.map((c) => c[1].url)).not.toContain(
    "https://c.com/3",
  );
});

test("pages already in the notebook show as added and are skipped", async () => {
  await mountReport({ existingUrls: ["https://a.com/1/"] });
  expect(text()).toContain("Already added");
  await click(buttonNamed("Import 2 selected sources")!);
  await flush(10);
  expect(createUrlSource).toHaveBeenCalledTimes(2);
});

test("saving as a note turns the button into a saved state that cannot be repeated", async () => {
  saveResearchNote.mockResolvedValue({
    noteId: "n1",
    sourceId: "s1",
    title: "t",
    alreadySaved: false,
  });
  const { onSaved } = await mountReport();
  await click(buttonNamed("Save report as a note")!);
  await flush(3);
  expect(saveResearchNote).toHaveBeenCalledWith("w1", "r1");
  expect(onSaved).toHaveBeenCalledTimes(1);
});

test("an already saved run shows the saved state and offers no second save", async () => {
  await mountReport({ saved: true });
  expect(buttonNamed("Save report as a note")).toBeUndefined();
  expect(buttonNamed("Saved")?.hasAttribute("disabled")).toBe(true);
});
