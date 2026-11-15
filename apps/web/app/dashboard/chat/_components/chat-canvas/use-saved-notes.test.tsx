// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const listSavedNotes = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { listSavedNotes },
}));

import { useSavedNotes } from "./use-saved-notes";
import { flush, mount, unmountAll } from "@/test/react";

beforeEach(() => listSavedNotes.mockReset());
afterEach(unmountAll);

function Probe({ ids }: { ids: string[] }) {
  const { notes } = useSavedNotes("w1", ids);
  return createElement("div", { "data-saved": Object.keys(notes).join(",") });
}

const saved = () =>
  document.body.querySelector("[data-saved]")?.getAttribute("data-saved");

test("loads which answers are saved and asks only for new ids afterwards", async () => {
  listSavedNotes.mockResolvedValue({
    notes: { m1: { noteId: "n1", sourceId: "s1", title: "A" } },
  });
  const view = await mount(createElement(Probe, { ids: ["m1", "m2"] }));
  await flush(3);
  assert.deepEqual(listSavedNotes.mock.calls[0], ["w1", ["m1", "m2"]]);
  assert.equal(saved(), "m1");

  listSavedNotes.mockResolvedValue({ notes: {} });
  await view.render(createElement(Probe, { ids: ["m1", "m2", "m3"] }));
  await flush(3);
  assert.deepEqual(listSavedNotes.mock.calls[1], ["w1", ["m3"]]);
});

test("a failed lookup leaves everything unsaved and is retried later", async () => {
  listSavedNotes.mockRejectedValueOnce(new Error("down"));
  const view = await mount(createElement(Probe, { ids: ["m1"] }));
  await flush(3);
  assert.equal(saved(), "");

  listSavedNotes.mockResolvedValue({ notes: {} });
  await view.render(createElement(Probe, { ids: ["m1", "m2"] }));
  await flush(3);
  assert.deepEqual(listSavedNotes.mock.calls[1], ["w1", ["m1", "m2"]]);
});
