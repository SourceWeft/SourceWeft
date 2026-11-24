import { expect, test } from "vitest";

import {
  ADMIN_DEFAULT_HREF,
  ADMIN_OVERVIEW_SECTION,
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
  const skills = { href: "/dashboard/admin/market/skills" };
  expect(isAdminSectionActive("/dashboard/admin/market/skills", skills)).toBe(true);
  expect(
    isAdminSectionActive("/dashboard/admin/blog/42", { href: "/dashboard/admin/blog" }),
  ).toBe(true);
  expect(isAdminSectionActive("/dashboard/admin/market/skill-review", skills)).toBe(false);
});

test("the overview is current only on the admin home address", () => {
  expect(isAdminSectionActive("/dashboard/admin", ADMIN_OVERVIEW_SECTION)).toBe(true);
  expect(isAdminSectionActive("/dashboard/admin/blog", ADMIN_OVERVIEW_SECTION)).toBe(false);
});

test("the skill review section counts both of its queues", () => {
  const overview = {
    pending: { mcpReview: 1, skillReview: 2, skillListing: 3, reports: 4 },
    blog: { drafts: 0, published: 0 },
  };
  const pending = Object.fromEntries(
    ADMIN_SECTION_GROUPS.flatMap((group) => group.sections)
      .filter((section) => section.pending)
      .map((section) => [section.key, section.pending!(overview)]),
  );
  expect(pending).toEqual({ mcpReview: 1, skillReview: 5, reports: 4 });
});

test("section addresses are unique", () => {
  const hrefs = ADMIN_SECTION_GROUPS.flatMap((group) =>
    group.sections.map((section) => section.href),
  );
  expect(new Set(hrefs).size).toBe(hrefs.length);
});
