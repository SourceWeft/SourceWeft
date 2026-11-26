// @vitest-environment jsdom

import { expect, test, vi } from "vitest";

import { isChunkLoadError, reloadForStaleBuild } from "./stale-build-reload";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("recognises a script file that failed to load", () => {
  const named = new Error("boom");
  named.name = "ChunkLoadError";
  expect(isChunkLoadError(named)).toBe(true);
  expect(
    isChunkLoadError(
      new Error("Failed to load chunk /_next/static/chunks/a.js from module 1"),
    ),
  ).toBe(true);
  expect(isChunkLoadError(new Error("Loading chunk 12 failed."))).toBe(true);
  expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
  expect(isChunkLoadError("Failed to load chunk")).toBe(false);
  expect(isChunkLoadError(null)).toBe(false);
});

test("reloads once, then not again within a minute", () => {
  const storage = memoryStorage();
  const reload = vi.fn();
  expect(reloadForStaleBuild({ storage, now: 1_000_000, reload })).toBe(true);
  expect(reloadForStaleBuild({ storage, now: 1_030_000, reload })).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(reloadForStaleBuild({ storage, now: 1_061_000, reload })).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});

test("does not reload when the time of the last reload cannot be kept", () => {
  const reload = vi.fn();
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("storage is off");
    },
  };
  // Without a record, a page whose files stay missing would reload forever.
  expect(reloadForStaleBuild({ storage: broken, now: 1, reload })).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
