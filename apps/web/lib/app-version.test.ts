import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// The Dockerfile declares ARG BUILD_SHA="" so the image builds without the
// build arg; that reaches the bundle as an empty string, not as undefined.
test("an unset build arg reads as dev rather than as a blank label", async () => {
  vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "");
  vi.stubEnv("NEXT_PUBLIC_BUILD_TIME", "");
  const { BUILD_SHA, SHORT_BUILD_SHA, BUILD_TIME } = await import(
    "./app-version"
  );
  assert.equal(BUILD_SHA, "dev");
  assert.equal(SHORT_BUILD_SHA, "dev");
  assert.equal(BUILD_TIME, "");
});

test("an injected commit is shortened for display", async () => {
  vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "9d3154a4c0ffee0000000000000000000000beef");
  const { SHORT_BUILD_SHA } = await import("./app-version");
  assert.equal(SHORT_BUILD_SHA, "9d3154a");
});
