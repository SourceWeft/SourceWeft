"use client";

import { useEffect } from "react";

/** CSS variable holding the height of the part of the screen the keyboard leaves visible. */
export const VISIBLE_VIEWPORT_HEIGHT_VAR = "--sw-visible-height";

type ViewportLike = Pick<
  VisualViewport,
  "height" | "scale" | "addEventListener" | "removeEventListener"
>;

/**
 * Keeps a full-screen app shell above the on-screen keyboard on touch screens.
 *
 * iOS does not shrink the layout viewport when the keyboard opens: `100dvh` stays the full
 * screen height and the browser scrolls the whole document up to bring the focused field into
 * view, which pushes the header under the status bar and leaves a gap above the keyboard.
 * This sizes the shell to the visible viewport instead and scrolls the document back to the
 * top, so the shell sits between the status bar and the keyboard. Pinch zoom is left alone.
 */
export function watchVisibleViewport(
  win: Window & { visualViewport?: ViewportLike | null },
  root: HTMLElement,
): () => void {
  const viewport = win.visualViewport;
  if (!viewport || !win.matchMedia?.("(pointer: coarse)").matches) {
    return () => {};
  }
  let frame = 0;
  const sync = () => {
    frame = 0;
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    root.style.setProperty(
      VISIBLE_VIEWPORT_HEIGHT_VAR,
      `${Math.round(viewport.height)}px`,
    );
    if (win.scrollY !== 0 || win.scrollX !== 0) win.scrollTo(0, 0);
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(sync);
  };
  sync();
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    root.style.removeProperty(VISIBLE_VIEWPORT_HEIGHT_VAR);
  };
}

export function useVisibleViewportHeight() {
  useEffect(() => watchVisibleViewport(window, document.documentElement), []);
}
