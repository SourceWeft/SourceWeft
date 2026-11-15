import { expect, test } from "vitest";

import {
  ADMIN_DEFAULT_HREF,
  ADMIN_SECTION_GROUPS,
  isAdminSectionActive,
  legacyMarketTabHref,
} from "./admin-sections";

test("every old Market tab address leads to its section", () => {
  expect(
    ["mcp", "skills", "reports", "all", "collections", "settings"].map(
      legacyMarketTabHref,
    ),
  ).toEqual([
    "/dashboard/admin/market/mcp-review",
    "/dashboard/admin/market/skill-review",
    "/dashboard/admin/market/reports",
    "/dashboard/admin/market/skills",
    "/dashboard/admin/market/collections",
    "/dashboard/admin/market/settings",
  ]);
});

test("a missing or unknown tab leads to the default section", () => {
  expect(legacyMarketTabHref(undefined)).toBe(ADMIN_DEFAULT_HREF);
  expect(legacyMarketTabHref("constructor")).toBe(ADMIN_DEFAULT_HREF);
});

test("a section is current on its own address and below it, not on a sibling", () => {
  expect(
    isAdminSectionActive(
      "/dashboard/admin/market/skills",
      "/dashboard/admin/market/skills",
    ),
  ).toBe(true);
  expect(
    isAdminSectionActive("/dashboard/admin/blog/42", "/dashboard/admin/blog"),
  ).toBe(true);
  expect(
    isAdminSectionActive(
      "/dashboard/admin/market/skill-review",
      "/dashboard/admin/market/skills",
    ),
  ).toBe(false);
});

test("section addresses are unique", () => {
  const hrefs = ADMIN_SECTION_GROUPS.flatMap((group) =>
    group.sections.map((section) => section.href),
  );
  expect(new Set(hrefs).size).toBe(hrefs.length);
});
