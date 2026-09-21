import { describe, expect, it } from "vitest";

import {
  defaultSkillsBrowseState,
  excludesBoundedSkills,
  firstSkillCategoryName,
  formatInstallCount,
  hasActiveSkillFilters,
  isCriticalSkillFlag,
  isInvalidCursorError,
  mergeSkillPages,
  parseSkillsBrowseState,
  partitionSkills,
  skillCategoryName,
  skillFlagLabel,
  skillsBrowseKey,
  skillsBrowseSearch,
  skillsCatalogRequest,
  SKILLS_PAGE_SIZE,
  visibleSkillCategories,
  type SkillsBrowseState,
} from "./skills-market-browse";

function parse(search: string) {
  return parseSkillsBrowseState(new URLSearchParams(search));
}

const narrowed: SkillsBrowseState = {
  category: "writing",
  trust: "verified",
  capability: "executable",
  installed: "not_installed",
  sort: "popular",
  query: "pdf tools",
};

describe("parseSkillsBrowseState", () => {
  it("defaults to the plain gallery", () => {
    expect(parse("")).toEqual(defaultSkillsBrowseState);
    expect(hasActiveSkillFilters(parse(""))).toBe(false);
  });

  it("reads every facet", () => {
    expect(
      parse(
        "category=writing&trust=verified&capability=executable&installed=not_installed&sort=popular&q=pdf+tools",
      ),
    ).toEqual(narrowed);
  });

  it("drops unknown facet values instead of sending them to the API", () => {
    expect(
      parse("trust=official&capability=scripts&installed=yes&sort=installed_first"),
    ).toEqual(defaultSkillsBrowseState);
  });

  it("rejects a category that is not a slug", () => {
    expect(parse("category=../admin").category).toBe("all");
    expect(parse("category=").category).toBe("all");
    expect(parse("category=Data-Analysis").category).toBe("data-analysis");
  });

  it("trims and bounds the query", () => {
    expect(parse("q=%20%20git%20%20").query).toBe("git");
    expect(parse(`q=${"x".repeat(500)}`).query).toHaveLength(200);
  });
});

describe("skillsBrowseSearch", () => {
  it("keeps the default view's URL clean", () => {
    expect(skillsBrowseSearch(defaultSkillsBrowseState)).toBe("");
  });

  it("round-trips through the URL", () => {
    expect(parse(skillsBrowseSearch(narrowed))).toEqual(narrowed);
  });

  it("leaves params it does not own and drops the ones reset to default", () => {
    const current = new URLSearchParams("install=1&trust=community&q=old");
    const next = new URLSearchParams(
      skillsBrowseSearch({ ...defaultSkillsBrowseState, sort: "new" }, current),
    );
    expect(next.get("install")).toBe("1");
    expect(next.get("sort")).toBe("new");
    expect(next.has("trust")).toBe(false);
    expect(next.has("q")).toBe(false);
    // The input is not mutated.
    expect(current.get("trust")).toBe("community");
  });

  it("gives equal states equal keys and different states different keys", () => {
    expect(skillsBrowseKey({ ...narrowed })).toBe(skillsBrowseKey(narrowed));
    expect(skillsBrowseKey({ ...narrowed, sort: "new" })).not.toBe(
      skillsBrowseKey(narrowed),
    );
  });
});

describe("skillsCatalogRequest", () => {
  it("sends only the page size for the default view", () => {
    expect(skillsCatalogRequest(defaultSkillsBrowseState)).toEqual({
      limit: SKILLS_PAGE_SIZE,
    });
  });

  it("maps every facet and the cursor onto the catalog API", () => {
    expect(skillsCatalogRequest(narrowed, "cursor-1")).toEqual({
      limit: SKILLS_PAGE_SIZE,
      cursor: "cursor-1",
      q: "pdf tools",
      category: "writing",
      trust: "verified",
      capability: "executable",
      installed: "not_installed",
      sort: "popular",
    });
  });

  it("starts from page one when there is no cursor", () => {
    expect(skillsCatalogRequest(narrowed, null)).not.toHaveProperty("cursor");
    expect(skillsCatalogRequest(narrowed)).not.toHaveProperty("cursor");
  });
});

describe("filters", () => {
  it("does not count the sort as a filter", () => {
    expect(
      hasActiveSkillFilters({ ...defaultSkillsBrowseState, sort: "name" }),
    ).toBe(false);
    expect(
      hasActiveSkillFilters({ ...defaultSkillsBrowseState, query: "git" }),
    ).toBe(true);
  });

  it("knows which filters leave built-ins and own skills out", () => {
    const base = defaultSkillsBrowseState;
    expect(excludesBoundedSkills(base)).toBe(false);
    expect(excludesBoundedSkills({ ...base, trust: "builtin" })).toBe(false);
    expect(excludesBoundedSkills({ ...base, installed: "installed" })).toBe(
      false,
    );
    expect(excludesBoundedSkills({ ...base, query: "git" })).toBe(false);
    expect(excludesBoundedSkills({ ...base, trust: "verified" })).toBe(true);
    expect(excludesBoundedSkills({ ...base, trust: "community" })).toBe(true);
    expect(excludesBoundedSkills({ ...base, category: "writing" })).toBe(true);
    expect(excludesBoundedSkills({ ...base, capability: "prompt-only" })).toBe(
      true,
    );
  });
});

describe("partitionSkills", () => {
  it("splits by origin and keeps the server's order inside each section", () => {
    const items = [
      { catalogId: "c2", sourceType: "registry_github" },
      { catalogId: "b1", sourceType: "builtin" },
      { catalogId: "w1", sourceType: "workspace_custom" },
      { catalogId: "c1", sourceType: "registry_github" },
      { catalogId: "t1", sourceType: "team_custom" },
    ];
    const sections = partitionSkills(items);
    expect(sections.builtin.map((item) => item.catalogId)).toEqual(["b1"]);
    expect(sections.yours.map((item) => item.catalogId)).toEqual(["w1", "t1"]);
    expect(sections.community.map((item) => item.catalogId)).toEqual([
      "c2",
      "c1",
    ]);
  });
});

describe("mergeSkillPages", () => {
  it("appends a page without repeating what is loaded", () => {
    const current = [{ catalogId: "a" }, { catalogId: "b" }];
    const merged = mergeSkillPages(current, [
      { catalogId: "b" },
      { catalogId: "c" },
      { catalogId: "c" },
    ]);
    expect(merged.map((item) => item.catalogId)).toEqual(["a", "b", "c"]);
    expect(current).toHaveLength(2);
  });
});

describe("categories", () => {
  const categories = [
    { slug: "writing", name: "Writing", description: null, count: 3 },
    { slug: "finance", name: "Finance", description: null, count: 0 },
    { slug: "data-analysis", name: "Data & Analysis", description: null, count: 1 },
  ];

  it("hides empty categories except the selected one", () => {
    expect(
      visibleSkillCategories(categories, "all").map((item) => item.slug),
    ).toEqual(["writing", "data-analysis"]);
    expect(
      visibleSkillCategories(categories, "finance").map((item) => item.slug),
    ).toEqual(["writing", "finance", "data-analysis"]);
  });

  it("names a slug from the taxonomy, or humanizes an unknown one", () => {
    expect(skillCategoryName("data-analysis", categories)).toBe(
      "Data & Analysis",
    );
    expect(skillCategoryName("web-scraping", categories)).toBe("Web Scraping");
    expect(skillCategoryName("learn", [])).toBe("Learn");
  });

  it("picks the first usable category for a card", () => {
    expect(
      firstSkillCategoryName({ categories: ["", " writing "] }, categories),
    ).toBe("Writing");
    expect(firstSkillCategoryName({ categories: [] }, categories)).toBeNull();
  });
});

describe("formatInstallCount", () => {
  it("shows nothing for zero, missing or nonsense counts", () => {
    expect(formatInstallCount(0)).toBeNull();
    expect(formatInstallCount(undefined)).toBeNull();
    expect(formatInstallCount(null)).toBeNull();
    expect(formatInstallCount(-4)).toBeNull();
    expect(formatInstallCount(Number.NaN)).toBeNull();
  });

  it("keeps small counts exact", () => {
    expect(formatInstallCount(1)).toBe("1");
    expect(formatInstallCount(999)).toBe("999");
  });

  it("compacts thousands and millions without rounding up", () => {
    expect(formatInstallCount(1000)).toBe("1k");
    expect(formatInstallCount(1250)).toBe("1.2k");
    expect(formatInstallCount(1999)).toBe("1.9k");
    expect(formatInstallCount(12_345)).toBe("12.3k");
    expect(formatInstallCount(999_999)).toBe("999.9k");
    expect(formatInstallCount(1_000_000)).toBe("1M");
    expect(formatInstallCount(3_450_000)).toBe("3.4M");
  });
});

describe("isInvalidCursorError", () => {
  it("matches the API's error code only", () => {
    expect(isInvalidCursorError({ code: "INVALID_CURSOR", status: 400 })).toBe(
      true,
    );
    expect(isInvalidCursorError({ code: "VALIDATION_ERROR" })).toBe(false);
    expect(isInvalidCursorError(new Error("INVALID_CURSOR"))).toBe(false);
    expect(isInvalidCursorError(null)).toBe(false);
  });
});

describe("review flags", () => {
  it("marks the flags a reviewer must not miss", () => {
    for (const flag of [
      "egress:pipe-to-shell",
      "egress:base64-exec",
      "injection:override",
      "secrets:read-credentials",
      "scope:other-skill-file",
      "binary:executable",
    ]) {
      expect(isCriticalSkillFlag(flag), flag).toBe(true);
    }
    for (const flag of [
      "egress:fetch",
      "secrets:env-access",
      "tool:sensitive",
      "sticky-review",
    ]) {
      expect(isCriticalSkillFlag(flag), flag).toBe(false);
    }
  });

  it("labels known flags and passes unknown ones through", () => {
    const labels = { "egress:fetch": "Outbound network call" };
    expect(skillFlagLabel("egress:fetch", labels)).toBe(
      "Outbound network call",
    );
    expect(skillFlagLabel("future:flag", labels)).toBe("future:flag");
  });
});
