import { expect, test } from "vitest";

import { errorStatus, skillMarketAdminSkillsQuery } from "./skill-market-audit";

test("the all-skills query carries only the filters that are set", () => {
  expect(skillMarketAdminSkillsQuery({})).toBe("");
  expect(
    skillMarketAdminSkillsQuery(
      {
        q: "  pdf tools ",
        standing: "owner_held",
        featured: false,
        reported: true,
      },
      { cursor: "abc", limit: 20 },
    ),
  ).toBe(
    "?q=pdf+tools&standing=owner_held&featured=false&reported=true&cursor=abc&limit=20",
  );
  expect(skillMarketAdminSkillsQuery({ q: "   " })).toBe("");
});

test("errorStatus reads the HTTP status off a failed call", () => {
  expect(errorStatus({ status: 403 })).toBe(403);
  expect(errorStatus(new Error("x"))).toBeNull();
  expect(errorStatus(null)).toBeNull();
});
