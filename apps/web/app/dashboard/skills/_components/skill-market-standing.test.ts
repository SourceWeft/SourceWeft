import { describe, expect, it } from "vitest";

import {
  canSaveSkillCategories,
  SKILL_CATEGORY_LIMIT,
  skillStandingKind,
  toggleSkillCategory,
} from "./skill-market-standing";

describe("skillStandingKind", () => {
  it("tells listed, withdrawn and simply-unlisted apart", () => {
    expect(
      skillStandingKind({ visibility: "public", listingHold: false }),
    ).toBe("public");
    expect(
      skillStandingKind({ visibility: "restricted", listingHold: true }),
    ).toBe("withdrawn");
    expect(
      skillStandingKind({ visibility: "restricted", listingHold: false }),
    ).toBe("restricted");
  });

  it("reads a public skill as public even with a stale hold flag", () => {
    expect(skillStandingKind({ visibility: "public", listingHold: true })).toBe(
      "public",
    );
  });
});

describe("toggleSkillCategory", () => {
  it("adds and removes a slug without mutating the input", () => {
    const selected = ["writing"];
    expect(toggleSkillCategory(selected, "finance")).toEqual([
      "writing",
      "finance",
    ]);
    expect(toggleSkillCategory(selected, "writing")).toEqual([]);
    expect(selected).toEqual(["writing"]);
  });

  it("never grows past the limit, but can still shrink at it", () => {
    const full = Array.from(
      { length: SKILL_CATEGORY_LIMIT },
      (_, index) => `c${index}`,
    );
    expect(toggleSkillCategory(full, "one-more")).toEqual(full);
    expect(toggleSkillCategory(full, "c0")).toHaveLength(
      SKILL_CATEGORY_LIMIT - 1,
    );
  });
});

describe("canSaveSkillCategories", () => {
  it("needs between one and five categories", () => {
    expect(canSaveSkillCategories(["a"], [])).toBe(false);
    expect(
      canSaveSkillCategories([], ["a", "b", "c", "d", "e", "f"]),
    ).toBe(false);
    expect(canSaveSkillCategories([], ["a"])).toBe(true);
  });

  it("needs an actual change, whatever the order", () => {
    expect(canSaveSkillCategories(["a", "b"], ["b", "a"])).toBe(false);
    expect(canSaveSkillCategories(["a", "b"], ["a", "c"])).toBe(true);
    expect(canSaveSkillCategories(["a", "b"], ["a"])).toBe(true);
  });
});
