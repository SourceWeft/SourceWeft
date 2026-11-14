// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const getSourceGuide = vi.hoisted(() => vi.fn());
const requestSourceGuide = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/sdk", () => ({
  contentClient: { getSourceGuide, requestSourceGuide },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));

import { SourceGuideCard } from "./source-guide-card";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

const READY = {
  sourceId: "s1",
  status: "ready",
  content: {
    summary: "Revenue grew in 2025.",
    topics: ["Revenue", "Cloud"],
    suggestedQuestions: ["What drove growth?", "How did margins change?"],
  },
  errorCode: null,
  trigger: "auto",
  stale: false,
  updatedAt: "2026-11-14T00:00:00.000Z",
};

const PREFERENCE_KEY = "sourceweft:source-guide-expanded";

// jsdom has no layout: each test says whether the screen is wide.
let wideScreen = true;

beforeEach(() => {
  getSourceGuide.mockReset();
  requestSourceGuide.mockReset();
  toastError.mockReset();
  push.mockReset();
  wideScreen = true;
  window.localStorage.clear();
  window.matchMedia = ((query: string) => ({
    matches: wideScreen,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(unmountAll);

async function mount(
  props: { collapsedByDefault?: boolean; onAsk?: () => void } = {},
) {
  await mountWithIntl(
    createElement(SourceGuideCard, {
      sourceId: "s1",
      workspaceId: "w1",
      ...props,
    }),
  );
  await flush();
}

const guideState = () =>
  document.body
    .querySelector("[data-source-guide]")
    ?.getAttribute("data-state");
const labelled = (label: string) =>
  document.body.querySelector<HTMLElement>(`button[aria-label="${label}"]`);

const text = () => document.body.textContent ?? "";
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(name),
  );

test("a ready guide shows the summary, topics and suggested questions", async () => {
  getSourceGuide.mockResolvedValue({ guide: READY });
  await mount();

  assert.ok(text().includes("Revenue grew in 2025."));
  assert.ok(text().includes("Cloud"));
  assert.ok(text().includes("What drove growth?"));
});

test("a source without a guide offers to generate one, and shows the result", async () => {
  getSourceGuide.mockResolvedValue({ guide: null });
  requestSourceGuide.mockResolvedValue({
    guide: { ...READY, status: "pending", content: null },
  });
  await mount();
  assert.ok(text().includes("No guide yet."));

  const generate = buttonNamed("Generate guide");
  assert.ok(generate);
  await click(generate);

  assert.equal(requestSourceGuide.mock.calls.length, 1);
  assert.ok(text().includes("Generating the guide"));
});

test("an empty balance says so and offers to try again", async () => {
  getSourceGuide.mockResolvedValue({
    guide: { ...READY, status: "pending", content: null, errorCode: "QUOTA" },
  });
  await mount();

  assert.ok(text().includes("not enough credits"));
  assert.ok(buttonNamed("Try again"));
});

test("a guide nobody can pay for lets the reader generate it with their own credits", async () => {
  getSourceGuide.mockResolvedValue({
    guide: {
      ...READY,
      status: "pending",
      content: null,
      errorCode: "NO_PAYER",
    },
  });
  await mount();

  assert.ok(text().includes("No account is available"));
  assert.ok(buttonNamed("Generate guide"));
});

test("a failed guide can be retried, but an empty source cannot", async () => {
  getSourceGuide.mockResolvedValue({
    guide: { ...READY, status: "failed", content: null, errorCode: "MODEL" },
  });
  await mount();
  assert.ok(buttonNamed("Try again"));

  await unmountAll();
  getSourceGuide.mockResolvedValue({
    guide: {
      ...READY,
      status: "failed",
      content: null,
      errorCode: "EMPTY_SOURCE",
    },
  });
  await mount();
  assert.ok(text().includes("no text to summarize"));
  assert.equal(buttonNamed("Try again"), undefined);
});

test("a stale guide keeps its content and offers to regenerate", async () => {
  getSourceGuide.mockResolvedValue({ guide: { ...READY, stale: true } });
  await mount();

  assert.ok(text().includes("Revenue grew in 2025."));
  assert.ok(text().includes("The source changed"));
  assert.ok(buttonNamed("Regenerate"));
});

test("the card stays out of the way when the guide cannot be loaded", async () => {
  getSourceGuide.mockRejectedValue(new Error("offline"));
  await mount();

  assert.equal(document.body.querySelector("[data-source-guide]"), null);
});

test("a suggested question opens a new chat with that source and the question", async () => {
  getSourceGuide.mockResolvedValue({ guide: READY });
  await mount();

  const question = buttonNamed("What drove growth?");
  assert.ok(question);
  await click(question);

  assert.equal(push.mock.calls.length, 1);
  const url = new URL(push.mock.calls[0]![0], "http://localhost");
  assert.equal(url.pathname, "/dashboard/chat");
  assert.equal(url.searchParams.get("ask"), "What drove growth?");
  assert.equal(url.searchParams.get("ask_source"), "s1");
});

test("a suggested question can also be copied", async () => {
  getSourceGuide.mockResolvedValue({ guide: READY });
  const writeText = vi.fn<(text: string) => Promise<void>>(
    async () => undefined,
  );
  Object.assign(navigator, { clipboard: { writeText } });
  await mount();

  const copy = document.body.querySelector(
    'button[aria-label="Copy question"]',
  );
  assert.ok(copy);
  await click(copy as HTMLElement);

  assert.equal(writeText.mock.calls[0]?.[0], "What drove growth?");
  assert.equal(push.mock.calls.length, 0);
});

test("on a wide screen the guide is an open rail, and closing it is remembered", async () => {
  getSourceGuide.mockResolvedValue({ guide: READY });
  await mount();
  assert.equal(guideState(), "expanded");
  assert.ok(text().includes("What drove growth?"));

  const collapse = labelled("Collapse guide");
  assert.ok(collapse);
  await click(collapse);

  assert.equal(guideState(), "collapsed");
  assert.equal(text().includes("Revenue grew in 2025."), false);
  assert.equal(window.localStorage.getItem(PREFERENCE_KEY), "false");

  const expand = labelled("Expand guide");
  assert.ok(expand);
  await click(expand);
  assert.equal(guideState(), "expanded");
  assert.equal(window.localStorage.getItem(PREFERENCE_KEY), "true");
});

test("a reader who closed the rail finds it closed the next time", async () => {
  window.localStorage.setItem(PREFERENCE_KEY, "false");
  getSourceGuide.mockResolvedValue({ guide: READY });
  await mount();

  assert.equal(guideState(), "collapsed");
  assert.equal(text().includes("What drove growth?"), false);
  assert.ok(labelled("Expand guide"));
});

test("a view that needs the width starts with the rail closed and leaves the remembered choice alone", async () => {
  getSourceGuide.mockResolvedValue({ guide: READY });
  await mount({ collapsedByDefault: true });
  assert.equal(guideState(), "collapsed");

  const expand = labelled("Expand guide");
  assert.ok(expand);
  await click(expand);

  assert.equal(guideState(), "expanded");
  assert.ok(text().includes("What drove growth?"));
  assert.equal(window.localStorage.getItem(PREFERENCE_KEY), null);
});

test("on a narrow screen the guide starts as one line of the summary and opens on request", async () => {
  wideScreen = false;
  getSourceGuide.mockResolvedValue({ guide: READY });
  await mount();

  assert.equal(guideState(), "collapsed");
  assert.ok(text().includes("Revenue grew in 2025."));
  assert.equal(text().includes("What drove growth?"), false);

  const preview = document.body.querySelector<HTMLElement>(
    "[data-source-guide-preview]",
  );
  assert.ok(preview);
  await click(preview);

  assert.equal(guideState(), "expanded");
  assert.ok(text().includes("What drove growth?"));
  assert.equal(window.localStorage.getItem(PREFERENCE_KEY), null);
});

test("on a narrow screen a guide that needs an action still says so", async () => {
  wideScreen = false;
  getSourceGuide.mockResolvedValue({ guide: null });
  await mount();

  assert.ok(text().includes("No guide yet."));
  assert.ok(buttonNamed("Generate guide"));
  assert.equal(labelled("Expand guide"), null);
});

test("asking a suggested question tells the surface showing the guide, copying one does not", async () => {
  getSourceGuide.mockResolvedValue({ guide: READY });
  Object.assign(navigator, {
    clipboard: { writeText: async () => undefined },
  });
  const onAsk = vi.fn();
  await mount({ onAsk });

  const copy = labelled("Copy question");
  assert.ok(copy);
  await click(copy);
  assert.equal(onAsk.mock.calls.length, 0);

  const question = buttonNamed("What drove growth?");
  assert.ok(question);
  await click(question);
  assert.equal(push.mock.calls.length, 1);
  assert.equal(onAsk.mock.calls.length, 1);
});
