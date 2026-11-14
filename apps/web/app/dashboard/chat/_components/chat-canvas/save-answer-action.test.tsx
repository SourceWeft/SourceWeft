// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const saveAnswerAsNote = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { saveAnswerAsNote },
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));
vi.mock("@sourceweft/ui-web/components/ai-elements/message", () => ({
  MessageAction: (props: Record<string, unknown>) =>
    createElement(
      "button",
      {
        "aria-label": props.label as string,
        disabled: props.disabled as boolean,
        onClick: props.onClick as () => void,
        type: "button",
      },
      props.children as never,
    ),
}));

import { SaveAnswerAction } from "./save-answer-action";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

beforeEach(() => {
  saveAnswerAsNote.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});
afterEach(unmountAll);

async function mount() {
  await mountWithIntl(
    createElement(SaveAnswerAction, { messageId: "m1", workspaceId: "w1" }),
  );
  await flush();
  const button = document.body.querySelector("button");
  assert.ok(button);
  return button;
}

test("saving sends the message and marks the answer as saved", async () => {
  saveAnswerAsNote.mockResolvedValue({
    noteId: "n1",
    sourceId: "s1",
    title: "Revenue",
    alreadySaved: false,
  });
  const button = await mount();
  assert.equal(button.getAttribute("aria-label"), "Save as note");

  await click(button);
  await flush();

  assert.deepEqual(saveAnswerAsNote.mock.calls[0], ["w1", "m1"]);
  assert.equal(button.getAttribute("aria-label"), "Saved as note");
  assert.ok(String(toastSuccess.mock.calls[0]?.[0]).includes("Revenue"));
});

test("a saved answer is not saved again", async () => {
  saveAnswerAsNote.mockResolvedValue({
    noteId: "n1",
    sourceId: "s1",
    title: "Revenue",
    alreadySaved: false,
  });
  const button = await mount();
  await click(button);
  await flush();
  await click(button);
  await flush();

  assert.equal(saveAnswerAsNote.mock.calls.length, 1);
});

test("a failure is reported and the answer can be saved again", async () => {
  saveAnswerAsNote.mockRejectedValue(new Error("down"));
  const button = await mount();

  await click(button);
  await flush();

  assert.equal(toastError.mock.calls.length, 1);
  assert.equal(button.getAttribute("aria-label"), "Save as note");
});
