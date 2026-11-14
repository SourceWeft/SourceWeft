// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const getNoteOrigin = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/sdk", () => ({ contentClient: { getNoteOrigin } }));
vi.mock("next/link", () => ({
  default: (props: { href: string; children: never }) =>
    createElement("a", { href: props.href }, props.children),
}));

import { NoteOriginCard } from "./note-origin-card";
import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";

const reference = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  sourceId: `s${number}`,
  sourceTitle: `Source ${number}`,
  sourceExists: true,
  passage: `Passage ${number}`,
  ...extra,
});

const ORIGIN = {
  noteId: "n1",
  thread: { id: "t1", title: "Q3 review" },
  messageId: "m1",
  savedAt: "2026-11-10T00:00:00.000Z",
  editedAt: null,
  references: [reference(1), reference(2, { sourceExists: false })],
};

beforeEach(() => getNoteOrigin.mockReset());
afterEach(unmountAll);

async function mount(props: Record<string, unknown> = {}) {
  await mountWithIntl(
    createElement(NoteOriginCard, {
      sourceId: "s0",
      workspaceId: "w1",
      ...props,
    }),
  );
  await flush(3);
}

test("shows the conversation, the cited sources and a deleted source", async () => {
  getNoteOrigin.mockResolvedValue({ origin: ORIGIN });
  await mount();

  assert.deepEqual(getNoteOrigin.mock.calls[0], ["w1", "s0"]);
  const link = document.body.querySelector("a");
  assert.equal(link?.getAttribute("href"), "/dashboard/chat/t1");
  assert.ok(document.body.textContent?.includes("Q3 review"));
  assert.ok(document.body.textContent?.includes("Passage 1"));
  assert.ok(
    document.body
      .querySelector('[data-note-reference="2"]')
      ?.textContent?.includes("(deleted)"),
  );
});

test("hides the conversation link when the viewer cannot read it", async () => {
  getNoteOrigin.mockResolvedValue({ origin: { ...ORIGIN, thread: null } });
  await mount();

  assert.equal(document.body.querySelector("a"), null);
  assert.ok(document.body.textContent?.includes("Source 1"));
});

test("opens a cited source and starts an edit", async () => {
  getNoteOrigin.mockResolvedValue({ origin: ORIGIN });
  const onOpenSource = vi.fn();
  const onEdit = vi.fn();
  await mount({ onOpenSource, onEdit });

  await click(button("Source 1"));
  assert.deepEqual(onOpenSource.mock.calls[0]?.[0], {
    id: "s1",
    title: "Source 1",
  });
  await click(button("Edit"));
  assert.equal(onEdit.mock.calls.length, 1);
});

test("only the first three references show until expanded", async () => {
  getNoteOrigin.mockResolvedValue({
    origin: { ...ORIGIN, references: [1, 2, 3, 4, 5].map((n) => reference(n)) },
  });
  await mount();
  assert.equal(
    document.body.querySelectorAll("[data-note-reference]").length,
    3,
  );

  await click(button("Show all 5"));
  assert.equal(
    document.body.querySelectorAll("[data-note-reference]").length,
    5,
  );
});

test("a note with no record still renders the edit action", async () => {
  getNoteOrigin.mockResolvedValue({ origin: null });
  await mount({ onEdit: vi.fn() });

  assert.ok(button("Edit"));
  assert.equal(
    document.body.querySelectorAll("[data-note-reference]").length,
    0,
  );
});
