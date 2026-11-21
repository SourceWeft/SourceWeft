"use client";

import { useEffect, type RefObject } from "react";

/** How close to the left edge a touch must start to count as an edge swipe, in CSS px. */
export const EDGE_SWIPE_START_PX = 24;
/** How far right the finger must travel before the swipe fires. */
export const EDGE_SWIPE_DISTANCE_PX = 40;

export type EdgeSwipeTrack = { x: number; y: number };

/** Whether a touch starting here may become an edge swipe. */
export function startsEdgeSwipe(x: number) {
  return x >= 0 && x <= EDGE_SWIPE_START_PX;
}

/**
 * Whether the finger has moved far enough right, and mostly sideways, to open the menu.
 * A mostly vertical move is a scroll and never opens it.
 */
export function completesEdgeSwipe(start: EdgeSwipeTrack, now: EdgeSwipeTrack) {
  const dx = now.x - start.x;
  const dy = Math.abs(now.y - start.y);
  return dx >= EDGE_SWIPE_DISTANCE_PX && dx > dy * 1.5;
}

/**
 * Calls `onSwipe` when a finger swipes right from the left edge of `ref`'s element, the way
 * iOS apps open their side menu. Only one call per touch.
 */
export function useLeftEdgeSwipe(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onSwipe: () => void,
) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let start: EdgeSwipeTrack | null = null;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 && touch && startsEdgeSwipe(touch.clientX)
          ? { x: touch.clientX, y: touch.clientY }
          : null;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      if (completesEdgeSwipe(start, { x: touch.clientX, y: touch.clientY })) {
        start = null;
        onSwipe();
      }
    };
    const onEnd = () => {
      start = null;
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: true });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onEnd);
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  }, [ref, enabled, onSwipe]);
}
