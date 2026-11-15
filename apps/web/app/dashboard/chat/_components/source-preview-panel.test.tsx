// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, test, vi } from "vitest";
import type { CitationRecord } from "./chat-canvas";

const getSourceDocument = vi.hoisted(() => vi.fn());
const getSource = vi.hoisted(() => vi.fn());
const getSourceGuide = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/sdk", () => ({
  contentClient: { getSourceDocument, getSource, getSourceGuide },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@sourceweft/ui-web/components/ai-elements/message", () => ({
  MessageResponse: (props: { children?: ReactNode }) =>
    createElement("div", { "data-testid": "markdown" }, props.children),
}));
vi.mock("@sourceweft/preview/react", () => ({
  Preview: () => null,
}));
vi.mock("./file-citation-preview", () => ({
  FileCitationPreview: () => null,
}));

import { SourcePreviewPanel } from "./source-preview-panel";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

const CONTENT =
  "Overview of the company. Revenue grew 23% to $4.1 billion in fiscal 2025. Headcount stayed flat.";
const PASSAGE = "Revenue grew 23% to $4.1 billion in fiscal 2025.";
const START = CONTENT.indexOf(PASSAGE);

function detail() {
  return {
    source: {
      id: "source-1",
      title: "Annual report",
      sourceType: "file",
      mimeType: "text/markdown",
      contentText: CONTENT,
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    documents: [{ id: "document-1", contentText: CONTENT }],
    chunks: [
      {
        id: "chunk-1",
        documentId: "document-1",
        chunkNo: 0,
        content: CONTENT,
        headingPath: null,
        startOffset: null,
        endOffset: null,
        language: null,
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    ],
  };
}

function citation(overrides: Partial<CitationRecord> = {}): CitationRecord {
  return {
    citation: "c1",
    sourceId: "source-1",
    documentId: "document-1",
    chunkId: "chunk-1",
    score: 0.9,
    excerpt: "excerpt",
    ...overrides,
  };
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= () => {};
  // jsdom has no CSS.escape; the panel's scroll-to-citation timers call it.
  (globalThis as { CSS?: { escape(value: string): string } }).CSS ??= {
    escape: (value: string) => value,
  };
});

afterEach(async () => {
  await unmountAll();
  getSourceDocument.mockReset();
  getSource.mockReset();
  getSourceGuide.mockReset();
  push.mockReset();
});

async function open(record: CitationRecord) {
  getSourceDocument.mockResolvedValue(detail());
  getSource.mockResolvedValue(detail());
  await mountWithIntl(
    createElement(SourcePreviewPanel, {
      citation: record,
      open: true,
      onOpenChange: () => {},
      workspaceId: "workspace-1",
    }),
  );
  await flush();
}

test("a strong citation shows the supporting passage above the chunk", async () => {
  await open(
    citation({
      support: "strong",
      startChar: START,
      endChar: START + PASSAGE.length,
      spanText: PASSAGE,
    }),
  );

  const passage = document.body.querySelector("[data-citation-passage]");
  assert.ok(passage);
  assert.ok(passage.textContent?.includes("Supporting passage"));
  assert.ok(passage.textContent?.includes(PASSAGE));
  assert.ok(!passage.textContent?.includes("Overview of the company"));
  assert.equal(document.body.textContent?.includes("not located"), false);
});

test("the raw chunk view highlights exactly the supporting passage", async () => {
  await open(
    citation({
      support: "strong",
      startChar: START,
      endChar: START + PASSAGE.length,
      spanText: PASSAGE,
    }),
  );

  const rawToggle = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Raw",
  );
  assert.ok(rawToggle);
  await click(rawToggle);

  const marks = document.body.querySelectorAll("pre mark");
  assert.equal(marks.length, 1);
  assert.equal(marks[0]?.textContent, PASSAGE);
  assert.equal(document.body.querySelector("pre")?.textContent, CONTENT);
});

test("a weak citation says the passage was not located and highlights nothing", async () => {
  await open(citation({ support: "weak" }));

  assert.ok(
    document.body.textContent?.includes("Supporting passage not located"),
  );
  assert.equal(document.body.querySelector("[data-citation-passage]"), null);
});

test("a citation without support information shows neither", async () => {
  await open(citation());

  assert.equal(document.body.querySelector("[data-citation-passage]"), null);
  assert.equal(document.body.textContent?.includes("not located"), false);
});

test("offsets that no longer fit the chunk are not highlighted", async () => {
  await open(
    citation({
      support: "strong",
      startChar: 10,
      endChar: CONTENT.length + 50,
      spanText: PASSAGE,
    }),
  );

  assert.equal(document.body.querySelector("[data-citation-passage]"), null);
});

test("a span whose text no longer matches the chunk is not highlighted", async () => {
  await open(
    citation({
      support: "strong",
      startChar: START,
      endChar: START + PASSAGE.length,
      spanText: "Revenue fell 5% in fiscal 2025.",
    }),
  );

  assert.equal(document.body.querySelector("[data-citation-passage]"), null);
});

test("asking a suggested question from the guide closes the preview and tells the surface that opened it", async () => {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  getSource.mockResolvedValue(detail());
  getSourceGuide.mockResolvedValue({
    guide: {
      sourceId: "source-1",
      status: "ready",
      content: {
        summary: "Revenue grew in 2025.",
        topics: ["Revenue"],
        suggestedQuestions: ["What drove growth?"],
      },
      errorCode: null,
      trigger: "auto",
      stale: false,
      updatedAt: "2026-11-14T00:00:00.000Z",
    },
  });
  const onOpenChange = vi.fn();
  const onAskQuestion = vi.fn();
  await mountWithIntl(
    createElement(SourcePreviewPanel, {
      source: { id: "source-1", title: "Annual report" } as never,
      open: true,
      onAskQuestion,
      onOpenChange,
      workspaceId: "workspace-1",
    }),
  );
  await flush();
  await flush();
  assert.equal(onAskQuestion.mock.calls.length, 0);

  const question = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.includes("What drove growth?"),
  );
  assert.ok(question);
  await click(question);

  assert.equal(push.mock.calls.length, 1);
  assert.deepEqual(onOpenChange.mock.calls.at(-1), [false]);
  assert.equal(onAskQuestion.mock.calls.length, 1);
});
