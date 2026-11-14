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

beforeEach(() => {
  getSourceGuide.mockReset();
  requestSourceGuide.mockReset();
  toastError.mockReset();
  push.mockReset();
});
afterEach(unmountAll);

async function mount() {
  await mountWithIntl(
    createElement(SourceGuideCard, { sourceId: "s1", workspaceId: "w1" }),
  );
  await flush();
}

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
