// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import {
  VISIBLE_VIEWPORT_HEIGHT_VAR,
  watchVisibleViewport,
} from "./visible-viewport";

function setup({ coarse = true, scale = 1 } = {}) {
  const listeners = new Map<string, () => void>();
  const viewport = {
    height: 844,
    scale,
    addEventListener: vi.fn((type: string, listener: () => void) =>
      listeners.set(type, listener),
    ),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
  };
  const frames: FrameRequestCallback[] = [];
  const win = {
    visualViewport: viewport,
    matchMedia: () => ({ matches: coarse }),
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      frames.push(callback),
    cancelAnimationFrame: vi.fn(),
  };
  const root = document.createElement("html");
  const stop = watchVisibleViewport(win as unknown as Window, root);
  const flush = () => frames.splice(0).forEach((frame) => frame(0));
  const height = () => root.style.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_VAR);
  return { flush, height, listeners, root, stop, viewport, win };
}

test("the shell shrinks above the keyboard and the page scrolls back to the top", () => {
  const { flush, height, listeners, viewport, win } = setup();
  expect(height()).toBe("844px");

  // The keyboard opens: iOS shrinks the visible viewport and scrolls the page up.
  viewport.height = 508;
  win.scrollY = 330;
  listeners.get("resize")?.();
  flush();
  expect(height()).toBe("508px");
  expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
});

test("pinch zoom leaves the shell alone", () => {
  const { flush, height, listeners, viewport } = setup();
  viewport.scale = 2;
  viewport.height = 422;
  listeners.get("resize")?.();
  flush();
  expect(height()).toBe("844px");
});

test("screens without touch keep the plain full height", () => {
  const { height, listeners } = setup({ coarse: false });
  expect(height()).toBe("");
  expect(listeners.size).toBe(0);
});

test("stopping removes the listeners and the height", () => {
  const { height, listeners, stop } = setup();
  stop();
  expect(listeners.size).toBe(0);
  expect(height()).toBe("");
});
