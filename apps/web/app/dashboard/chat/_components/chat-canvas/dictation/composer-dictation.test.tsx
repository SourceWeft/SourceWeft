// @vitest-environment jsdom
import { act, createElement } from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

// The composer's dictation slot calls this hook; the mock lets each test drive
// `visible`/`active`/`snapshot` and watch `toggle`/`stop`.
const dictation = vi.hoisted(() => ({
  state: {
    visible: true,
    active: false,
    snapshot: { status: "idle", notice: null },
    toggle: () => {},
    stop: () => Promise.resolve(),
  } as {
    visible: boolean;
    active: boolean;
    snapshot: { status: string; notice: string | null };
    toggle: () => void;
    stop: () => Promise<void>;
  },
}));

// composer.tsx imports the slot's hook as "./dictation/use-dictation", which
// resolves to this same module (./use-dictation relative to this test).
vi.mock("./use-dictation", () => ({
  useDictation: () => dictation.state,
}));

import { Composer } from "../composer";

beforeEach(() => {
  dictation.state = {
    visible: true,
    active: false,
    snapshot: { status: "idle", notice: null },
    toggle: vi.fn(),
    stop: vi.fn(() => Promise.resolve()),
  };
});

afterEach(unmountAll);

function micButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>("[data-dictation-button]");
}

async function submitForm(container: HTMLElement) {
  const form = container.querySelector("form");
  assert.ok(form, "composer form rendered");
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

test("no microphone button without a workspace id", async () => {
  const view = await mountWithIntl(
    createElement(Composer, { onSubmit: vi.fn() }),
  );
  assert.equal(micButton(view.container), null);
});

test("no microphone button when dictation is not visible", async () => {
  dictation.state.visible = false;
  const view = await mountWithIntl(
    createElement(Composer, { onSubmit: vi.fn(), dictationWorkspaceId: "ws1" }),
  );
  assert.equal(micButton(view.container), null);
});

test("the button sits after the image button and toggles dictation", async () => {
  const view = await mountWithIntl(
    createElement(Composer, { onSubmit: vi.fn(), dictationWorkspaceId: "ws1" }),
  );
  const image = view.container.querySelector<HTMLButtonElement>(
    'button[title="Add image"]',
  );
  const mic = micButton(view.container);
  assert.ok(image, "image button rendered");
  assert.ok(mic, "microphone button rendered");
  assert.ok(
    image.compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_FOLLOWING,
    "microphone button comes after the image button",
  );

  await click(mic);
  assert.equal((dictation.state.toggle as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("pressing send while dictation is active stops dictation and does not submit", async () => {
  dictation.state.active = true;
  const onSubmit = vi.fn();
  const view = await mountWithIntl(
    createElement(Composer, {
      onSubmit,
      dictationWorkspaceId: "ws1",
      initialInput: "hello",
    }),
  );

  await submitForm(view.container);

  assert.equal(onSubmit.mock.calls.length, 0);
  assert.equal((dictation.state.stop as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("Escape while dictation is active stops it", async () => {
  dictation.state.active = true;
  const view = await mountWithIntl(
    createElement(Composer, { onSubmit: vi.fn(), dictationWorkspaceId: "ws1" }),
  );
  const editor = view.container.querySelector(
    '[data-prompt-input-editor="true"]',
  );
  assert.ok(editor, "editor rendered");

  await act(async () => {
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  assert.equal((dictation.state.stop as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("sending works as before when dictation is idle", async () => {
  const onSubmit = vi.fn();
  const view = await mountWithIntl(
    createElement(Composer, {
      onSubmit,
      dictationWorkspaceId: "ws1",
      initialInput: "hello",
    }),
  );

  await submitForm(view.container);

  assert.equal(onSubmit.mock.calls.length, 1);
  assert.equal((dictation.state.stop as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});
