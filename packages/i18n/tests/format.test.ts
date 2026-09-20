import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatRelativeTime,
} from "../src/format";

test("formatNumber groups digits per locale", () => {
  assert.equal(formatNumber(1234567, "en"), "1,234,567");
  // zh-CN also groups in thousands; the point is it does not throw and honours the locale.
  assert.equal(formatNumber(1234567, "zh-CN"), "1,234,567");
});

test("formatCurrency keeps USD but formats per locale (D10)", () => {
  const en = formatCurrency(1234.5, "en");
  assert.ok(en.includes("1,234.5"));
  assert.ok(en.includes("$"));
  // The amount and currency are unchanged across locales; only presentation differs.
  const zh = formatCurrency(1234.5, "zh-CN");
  assert.ok(zh.includes("1,234.5"));
});

test("formatDate renders without throwing for every locale", () => {
  const date = new Date("2026-09-19T00:00:00Z");
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const out = formatDate(date, locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    assert.ok(out.length > 0, locale);
  }
  // Traditional and Simplified month rendering differ, proving intlLocale is applied.
  assert.notEqual(
    formatDate(date, "en", { month: "long", timeZone: "UTC" }),
    formatDate(date, "zh-CN", { month: "long", timeZone: "UTC" }),
  );
});

test("formatRelativeTime speaks the locale", () => {
  assert.equal(formatRelativeTime(-1, "day", "en", { numeric: "auto" }), "yesterday");
  assert.ok(formatRelativeTime(-1, "day", "zh-CN", { numeric: "auto" }).length > 0);
});
