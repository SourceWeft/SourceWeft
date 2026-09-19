import assert from "node:assert/strict";
import { test } from "vitest";

import { detectPlatform, isMobilePlatform } from "./detect-platform";

test("prefers client hints when available", () => {
  assert.equal(
    detectPlatform({ userAgentData: { platform: "macOS" } }),
    "macos",
  );
  assert.equal(
    detectPlatform({ userAgentData: { platform: "Windows" } }),
    "windows",
  );
  assert.equal(
    detectPlatform({ userAgentData: { platform: "Android", mobile: true } }),
    "android",
  );
  assert.equal(
    detectPlatform({ userAgentData: { platform: "Unknown", mobile: true } }),
    "mobile",
  );
  assert.equal(
    detectPlatform({ userAgentData: { platform: "Linux" } }),
    "linux",
  );
});

test("falls back to user agent strings", () => {
  const cases: Array<[string, string, ReturnType<typeof detectPlatform>]> = [
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15",
      "MacIntel",
      "macos",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128",
      "Win32",
      "windows",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0", "Linux x86_64", "linux"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1",
      "iPhone",
      "ios",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128 Mobile Safari/537.36",
      "Linux armv8l",
      "android",
    ],
    ["Mozilla/5.0 (Mobile; rv:130.0) Gecko/130.0 Firefox/130.0", "", "mobile"],
  ];
  for (const [userAgent, platform, expected] of cases) {
    assert.equal(detectPlatform({ userAgent, platform }), expected, userAgent);
  }
});

test("treats touch Macs as iPadOS", () => {
  assert.equal(
    detectPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari",
      platform: "MacIntel",
      maxTouchPoints: 5,
    }),
    "ios",
  );
});

test("returns unknown without a navigator", () => {
  assert.equal(detectPlatform(undefined), "unknown");
  assert.equal(detectPlatform({}), "unknown");
});

test("groups phone platforms", () => {
  assert.equal(isMobilePlatform("ios"), true);
  assert.equal(isMobilePlatform("android"), true);
  assert.equal(isMobilePlatform("mobile"), true);
  assert.equal(isMobilePlatform("macos"), false);
});
