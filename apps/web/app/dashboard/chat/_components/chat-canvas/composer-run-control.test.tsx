// @vitest-environment jsdom
import { createElement } from "react";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { click, mountWithIntl, unmountAll } from "@/test/react";
import { Composer } from "./composer";

afterEach(unmountAll);

function submitButton(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Stop"], button[aria-label="Submit"]',
  );
  assert.ok(button, "submit slot rendered");
  return button;
}

test("a pending Stop renders a disabled Stop that neither stops nor submits", async () => {
  const onSubmit = vi.fn();
  const view = await mountWithIntl(
    createElement(Composer, { onSubmit, stopPending: true }),
  );
  const button = submitButton(view.container);
  assert.equal(button.getAttribute("aria-label"), "Stop");
  assert.equal(button.disabled, true);
  await click(button);
  assert.equal(onSubmit.mock.calls.length, 0);
});

test("a live Stop calls the stop handler", async () => {
  const onStopStreaming = vi.fn();
  const view = await mountWithIntl(
    createElement(Composer, { onStopStreaming }),
  );
  const button = submitButton(view.container);
  assert.equal(button.getAttribute("aria-label"), "Stop");
  assert.equal(button.disabled, false);
  await click(button);
  assert.equal(onStopStreaming.mock.calls.length, 1);
});

test("without a run the slot is Send", async () => {
  const view = await mountWithIntl(createElement(Composer, {}));
  assert.equal(
    submitButton(view.container).getAttribute("aria-label"),
    "Submit",
  );
});
