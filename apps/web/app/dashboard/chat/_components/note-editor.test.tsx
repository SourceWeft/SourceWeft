// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";

const updateNoteContent = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/sdk", () => ({
  contentClient: { updateNoteContent },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));

import { NoteEditor } from "./note-editor";
import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";

const handlers = {
  onCancel: vi.fn(),
  onChanged: vi.fn(),
  onSaved: vi.fn(),
};

beforeEach(() => {
  updateNoteContent.mockReset();
  toastError.mockReset();
  Object.values(handlers).forEach((fn) => fn.mockReset());
});
afterEach(unmountAll);

async function mount() {
  await mountWithIntl(
    createElement(NoteEditor, {
      expectedUpdatedAt: "2026-11-10T00:00:00.000Z",
      initialText: "Original",
      sourceId: "s1",
      workspaceId: "w1",
      ...handlers,
    }),
  );
  await flush();
  return document.body.querySelector("textarea")!;
}

async function edit(field: HTMLTextAreaElement, value: string) {
  typeInto(field, value);
  await flush();
}

test("save is disabled until the text changes and is not empty", async () => {
  const field = await mount();
  assert.equal(button("Save").disabled, true);
  await edit(field, "   ");
  assert.equal(button("Save").disabled, true);
  await edit(field, "Changed");
  assert.equal(button("Save").disabled, false);
});

test("saving sends the text with the version it started from", async () => {
  updateNoteContent.mockResolvedValue({
    updatedAt: "2026-11-11T00:00:00.000Z",
  });
  const field = await mount();
  await edit(field, "Changed");
  await click(button("Save"));
  await flush();

  assert.deepEqual(updateNoteContent.mock.calls[0], [
    "w1",
    "s1",
    { contentText: "Changed", expectedUpdatedAt: "2026-11-10T00:00:00.000Z" },
  ]);
  assert.equal(handlers.onSaved.mock.calls.length, 1);
});

test("a conflict blocks saving, keeps the text and offers reload", async () => {
  updateNoteContent.mockRejectedValue(
    new HttpClientError({
      message: "conflict",
      status: 409,
      statusText: "Conflict",
      code: "NOTE_CONFLICT",
    }),
  );
  const field = await mount();
  await edit(field, "Changed");
  await click(button("Save"));
  await flush();

  assert.ok(document.body.querySelector("[data-note-conflict]"));
  assert.equal(field.value, "Changed");
  assert.equal(button("Save").disabled, true);
  assert.equal(handlers.onSaved.mock.calls.length, 0);
  await click(button("Reload note"));
  assert.equal(handlers.onCancel.mock.calls.length, 1);
});

test("an indexing failure keeps the draft, reports the change and allows a retry", async () => {
  updateNoteContent.mockRejectedValueOnce(new Error("index down"));
  const field = await mount();
  await edit(field, "Changed");
  await click(button("Save"));
  await flush();

  assert.ok(document.body.querySelector("[data-note-indexing]"));
  assert.equal(handlers.onChanged.mock.calls.length, 1);
  assert.equal(toastError.mock.calls.length, 1);
  assert.equal(field.value, "Changed");
  assert.equal(button("Save").disabled, false);
});
