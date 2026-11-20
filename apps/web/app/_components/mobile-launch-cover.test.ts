// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import {
  LAUNCH_COVER_CLASS,
  LAUNCH_COVER_SCRIPT,
  liftMobileLaunchCover,
} from "./mobile-launch-cover";

const root = () => document.documentElement;

afterEach(() => {
  root().classList.remove(LAUNCH_COVER_CLASS);
  delete (window as { __SOURCEWEFT_NATIVE__?: unknown }).__SOURCEWEFT_NATIVE__;
  vi.useRealTimers();
});

test("the cover goes up only inside the mobile app", () => {
  new Function(LAUNCH_COVER_SCRIPT)();
  expect(root().classList.contains(LAUNCH_COVER_CLASS)).toBe(false);

  (window as { __SOURCEWEFT_NATIVE__?: unknown }).__SOURCEWEFT_NATIVE__ = {
    kind: "desktop",
  };
  new Function(LAUNCH_COVER_SCRIPT)();
  expect(root().classList.contains(LAUNCH_COVER_CLASS)).toBe(false);

  (window as { __SOURCEWEFT_NATIVE__?: unknown }).__SOURCEWEFT_NATIVE__ = {
    kind: "mobile",
  };
  new Function(LAUNCH_COVER_SCRIPT)();
  expect(root().classList.contains(LAUNCH_COVER_CLASS)).toBe(true);
});

test("the cover lifts after React has painted, or by itself if the page never runs", () => {
  vi.useFakeTimers();
  (window as { __SOURCEWEFT_NATIVE__?: unknown }).__SOURCEWEFT_NATIVE__ = {
    kind: "mobile",
  };
  new Function(LAUNCH_COVER_SCRIPT)();
  vi.advanceTimersByTime(10_000);
  expect(root().classList.contains(LAUNCH_COVER_CLASS)).toBe(false);

  root().classList.add(LAUNCH_COVER_CLASS);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  liftMobileLaunchCover();
  frames.shift()?.(0);
  expect(root().classList.contains(LAUNCH_COVER_CLASS)).toBe(true);
  frames.shift()?.(0);
  expect(root().classList.contains(LAUNCH_COVER_CLASS)).toBe(false);
  vi.unstubAllGlobals();
});
