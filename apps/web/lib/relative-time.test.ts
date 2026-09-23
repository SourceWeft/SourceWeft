import { expect, test } from "vitest";
import { formatShortRelativeTime } from "./relative-time";
const now = new Date("2026-09-23T12:00:00Z");
test("relative dates follow the locale with English as default and invalid-locale fallback", () => {
  const then = new Date(now.getTime() - 8 * 60_000);
  expect(formatShortRelativeTime(then, "en", now)).toContain("ago");
  expect(formatShortRelativeTime(then, "zh-CN", now)).toBe("8分钟前");
  expect(formatShortRelativeTime(then, "zh-TW", now)).toBe("8 分鐘前");
  expect(formatShortRelativeTime(then, "invalid_!", now)).toBe(
    formatShortRelativeTime(then, "en", now),
  );
  expect(formatShortRelativeTime("invalid", "en", now)).toBe("now");
  expect(
    formatShortRelativeTime(new Date(now.getTime() + 60_000), "en", now),
  ).toBe("in 1 min.");
});
