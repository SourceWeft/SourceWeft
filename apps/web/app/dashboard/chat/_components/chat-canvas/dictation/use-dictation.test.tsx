// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

import { click, flush, mount, unmountAll } from "@/test/react";

// Spies the tests drive. `vi.hoisted` so they exist before the mocks below.
const spies = vi.hoisted(() => ({
  startPcmCapture: vi.fn(),
  transcribeDictationSegment: vi.fn(),
  getDictationAvailability: vi.fn(),
}));

vi.mock("@sourceweft/ui-web/lib/audio/pcm-capture", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@sourceweft/ui-web/lib/audio/pcm-capture")
    >();
  return {
    ...actual,
    isPcmCaptureSupported: () => true,
    startPcmCapture: (...args: unknown[]) => spies.startPcmCapture(...args),
  };
});

vi.mock("@sourceweft/ui-web/components/ai-elements/prompt-input", () => ({
  usePromptInputController: () => ({ insertText: () => true }),
}));

vi.mock("@/lib/native-host", () => ({
  useNativeHost: () => ({ kind: "web" }),
}));

vi.mock("@/lib/sdk", () => ({
  contentClient: {
    getDictationAvailability: (...args: unknown[]) =>
      spies.getDictationAvailability(...args),
    transcribeDictationSegment: (...args: unknown[]) =>
      spies.transcribeDictationSegment(...args),
  },
}));

const { useDictation, sendSegment, SEGMENT_REQUEST_TIMEOUT_MS } = await import(
  "./use-dictation"
);
const { SegmentSendError } = await import("./segment-transport");

function Harness() {
  const dictation = useDictation({ workspaceId: "ws1" });
  return createElement(
    "button",
    { "data-testid": "toggle", onClick: () => dictation.toggle() },
    dictation.snapshot.status,
  );
}

function toggleButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>("[data-testid=toggle]")!;
}

beforeEach(() => {
  spies.startPcmCapture.mockReset().mockResolvedValue({ stop: vi.fn() });
  spies.transcribeDictationSegment.mockReset();
  spies.getDictationAvailability
    .mockReset()
    .mockResolvedValue({ available: true });
});

afterEach(unmountAll);

test("the microphone still starts after a StrictMode mount/cleanup/mount", async () => {
  const captureStop = vi.fn();
  spies.startPcmCapture.mockResolvedValue({ stop: captureStop });

  const view = await mount(
    createElement(StrictMode, null, createElement(Harness)),
  );
  // StrictMode has already mounted, cleaned up (disposing the first session)
  // and mounted again by now; the disposed session must not be reused.
  await click(toggleButton(view.container));
  await flush(4);

  assert.equal(spies.startPcmCapture.mock.calls.length, 1);
});

test("Escape anywhere on the page stops an active dictation", async () => {
  const captureStop = vi.fn();
  spies.startPcmCapture.mockResolvedValue({ stop: captureStop });

  const view = await mount(createElement(Harness));
  await click(toggleButton(view.container));
  await flush(4);
  assert.equal(toggleButton(view.container).textContent, "listening");

  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await flush(4);

  assert.equal(captureStop.mock.calls.length, 1);
});

test("Escape does nothing when dictation is inactive", async () => {
  const captureStop = vi.fn();
  spies.startPcmCapture.mockResolvedValue({ stop: captureStop });

  await mount(createElement(Harness));

  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await flush(2);

  assert.equal(captureStop.mock.calls.length, 0);
  assert.equal(spies.startPcmCapture.mock.calls.length, 0);
});

test("a segment request that never answers times out as a network failure", async () => {
  vi.useFakeTimers();
  try {
    // Never resolves on its own; only an abort (from the timeout) settles it.
    spies.transcribeDictationSegment.mockImplementation(
      (_workspaceId: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const signal = new AbortController().signal;
    const promise = sendSegment(
      "ws1",
      "sess",
      0,
      new Uint8Array([1, 2, 3]),
      signal,
    );
    const assertion = assert.rejects(
      promise,
      (error: unknown) =>
        error instanceof SegmentSendError && error.status === null,
    );

    await vi.advanceTimersByTimeAsync(SEGMENT_REQUEST_TIMEOUT_MS);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});
