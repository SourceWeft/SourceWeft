import { describe, expect, it } from "vitest";

import {
  defaultSkillsBrowseState,
  hasOnlyCategoryFacet,
  isSkillsListView,
  isSkillsNarrowed,
  parseSkillsBrowseState,
  SKILLS_PAGE_SIZE,
  skillsBrowseHref,
  skillsListRequest,
} from "./skills-browse";

describe("parseSkillsBrowseState", () => {
  it("defaults to the browse home", () => {
    const state = parseSkillsBrowseState({});
    expect(state).toEqual({ ...defaultSkillsBrowseState, cursor: undefined });
    expect(isSkillsListView(state)).toBe(false);
  });

  it("takes the category from the route, not the query string", () => {
    expect(
      parseSkillsBrowseState(
        { category: "ignored" },
        { category: "data-analysis" },
      ).category,
    ).toBe("data-analysis");
    expect(parseSkillsBrowseState({ category: "data-analysis" }).category).toBe(
      "all",
    );
  });

  it("reads every facet", () => {
    expect(
      parseSkillsBrowseState({
        cursor: "abc",
        q: "  pdf forms ",
        sort: "popular",
        trust: "verified",
        type: "executable",
      }),
    ).toEqual({
      capability: "executable",
      category: "all",
      cursor: "abc",
      query: "pdf forms",
      sort: "popular",
      trust: "verified",
      view: false,
    });
  });

  it("drops unknown facet values and takes the first of a repeated param", () => {
    const state = parseSkillsBrowseState({
      sort: "trending",
      trust: ["verified", "x"],
      type: "binary",
    });
    expect(state.sort).toBe("recommended");
    expect(state.trust).toBe("verified");
    expect(state.capability).toBe("all");
  });

  it("keeps the query and cursor within what the API accepts", () => {
    const state = parseSkillsBrowseState({
      cursor: "c".repeat(1025),
      q: "q".repeat(500),
    });
    expect(state.query).toHaveLength(200);
    expect(state.cursor).toBeUndefined();
  });
});

describe("list view", () => {
  it("is on for any narrowing, a category, a sort, or an explicit view", () => {
    const base = defaultSkillsBrowseState;
    expect(isSkillsListView({ ...base, view: true })).toBe(true);
    expect(isSkillsListView({ ...base, query: "pdf" })).toBe(true);
    expect(isSkillsListView({ ...base, cursor: "abc" })).toBe(true);
    expect(isSkillsListView({ ...base, category: "writing" })).toBe(true);
    expect(isSkillsListView({ ...base, trust: "verified" })).toBe(true);
    expect(isSkillsListView({ ...base, capability: "prompt-only" })).toBe(true);
    expect(isSkillsListView({ ...base, sort: "new" })).toBe(true);
  });

  it("does not count the route category or a bare view as narrowing", () => {
    const base = defaultSkillsBrowseState;
    expect(isSkillsNarrowed({ ...base, category: "writing", view: true })).toBe(
      false,
    );
    expect(isSkillsNarrowed({ ...base, sort: "name" })).toBe(true);
    expect(isSkillsNarrowed({ ...base, cursor: "abc" })).toBe(true);
  });

  it("only trusts category counts when nothing else filters", () => {
    const base = defaultSkillsBrowseState;
    expect(
      hasOnlyCategoryFacet({ ...base, category: "writing", sort: "new" }),
    ).toBe(true);
    expect(hasOnlyCategoryFacet({ ...base, query: "pdf" })).toBe(false);
    expect(hasOnlyCategoryFacet({ ...base, trust: "verified" })).toBe(false);
    expect(hasOnlyCategoryFacet({ ...base, capability: "executable" })).toBe(
      false,
    );
  });
});

describe("skillsListRequest", () => {
  it("sends only the page size and sort for the unfiltered list", () => {
    expect(skillsListRequest(defaultSkillsBrowseState)).toEqual({
      limit: SKILLS_PAGE_SIZE,
      sort: "recommended",
    });
  });

  it("maps every facet onto the market API", () => {
    expect(
      skillsListRequest({
        capability: "prompt-only",
        category: "writing",
        cursor: "abc",
        query: "memo",
        sort: "name",
        trust: "verified",
        view: false,
      }),
    ).toEqual({
      capability: "prompt-only",
      category: "writing",
      cursor: "abc",
      limit: SKILLS_PAGE_SIZE,
      query: "memo",
      sort: "name",
      verified: true,
    });
  });

  it("never sends verified=false: unverified skills are not a facet", () => {
    expect(skillsListRequest(defaultSkillsBrowseState)).not.toHaveProperty(
      "verified",
    );
  });
});

describe("skillsBrowseHref", () => {
  const base = defaultSkillsBrowseState;

  it("puts the category in the path and facets in the query", () => {
    expect(
      skillsBrowseHref(
        { ...base, query: "pdf forms", trust: "verified" },
        {
          capability: "executable",
          category: "data-analysis",
          sort: "popular",
        },
      ),
    ).toBe(
      "/skills/category/data-analysis?q=pdf+forms&sort=popular&trust=verified&type=executable",
    );
  });

  it("omits defaults", () => {
    expect(skillsBrowseHref(base)).toBe("/skills");
    expect(skillsBrowseHref({ ...base, category: "writing" })).toBe(
      "/skills/category/writing",
    );
  });

  it("marks the unfiltered full listing so it differs from the home", () => {
    expect(skillsBrowseHref(base, { view: true })).toBe("/skills?view=all");
    expect(skillsBrowseHref(base, { sort: "new", view: true })).toBe(
      "/skills?sort=new",
    );
    expect(skillsBrowseHref(base, { category: "writing", view: true })).toBe(
      "/skills/category/writing",
    );
  });

  it("resets the cursor on any change, because it belongs to one sort and filter set", () => {
    const paged = { ...base, cursor: "abc", sort: "new" as const };
    expect(skillsBrowseHref(paged, { sort: "popular" })).toBe(
      "/skills?sort=popular",
    );
    expect(skillsBrowseHref(paged, { trust: "verified" })).toBe(
      "/skills?sort=new&trust=verified",
    );
    expect(skillsBrowseHref(paged, { cursor: "next" })).toBe(
      "/skills?sort=new&cursor=next",
    );
  });

  it("round-trips through the parser", () => {
    const state = {
      ...base,
      capability: "executable" as const,
      cursor: "a+b/c=",
      query: "c++ & rust",
      sort: "name" as const,
      trust: "verified" as const,
    };
    const url = new URL(
      skillsBrowseHref(state, { cursor: state.cursor }),
      "https://x.test",
    );
    const params = Object.fromEntries(url.searchParams.entries());
    expect(parseSkillsBrowseState(params)).toEqual(state);
  });

  it("encodes a category slug it is handed", () => {
    expect(skillsBrowseHref(base, { category: "a/b" })).toBe(
      "/skills/category/a%2Fb",
    );
  });
});
