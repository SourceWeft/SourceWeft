import { describe, expect, it } from "vitest";
import { formatDisplayDate } from "./format";
import { formatClaimDate } from "../../app/dashboard/skills/claim/_components/claim-view";

for (const locale of ["en", "zh-CN", "zh-TW"]) {
  describe(locale, () => {
    it("formats dates in the selected language regardless of navigator language", () => {
      const date = new Date("2026-09-22T12:34:56Z");
      const options = {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      } as const;
      expect(formatDisplayDate(date, locale, options)).toBe(
        new Intl.DateTimeFormat(locale, options).format(date),
      );
      expect(formatClaimDate(date.toISOString(), locale)).toBe(
        new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }).format(date),
      );
    });
  });
}
it("retains invalid claim timestamps and rejects unsupported UI locales", () => {
  expect(formatClaimDate("unknown", "zh-CN")).toBe("unknown");
  expect(formatDisplayDate.bind(null, new Date(), "invalid")).toThrow(
    RangeError,
  );
});
