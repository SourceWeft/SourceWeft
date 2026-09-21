import type {
  ListSkillsCatalogParams,
  SkillCatalogCapability,
  SkillCatalogCategory,
  SkillCatalogInstalled,
  SkillCatalogSort,
  SkillCatalogTrust,
} from "@sourceweft/contracts";

/**
 * The gallery's browse state and everything derived from it, kept free of React
 * so it can be tested on its own: URL parsing/serialisation, the catalog
 * request, and the small display rules the cards share.
 */

export const SKILLS_PAGE_SIZE = 48;
export const SKILLS_QUERY_MAX_LENGTH = 200;

export const skillTrustValues = [
  "all",
  "builtin",
  "verified",
  "community",
] as const satisfies readonly SkillCatalogTrust[];
export const skillCapabilityValues = [
  "all",
  "prompt-only",
  "executable",
] as const satisfies readonly SkillCatalogCapability[];
export const skillInstalledValues = [
  "all",
  "installed",
  "not_installed",
] as const satisfies readonly SkillCatalogInstalled[];
export const skillSortValues = [
  "recommended",
  "popular",
  "stars",
  "new",
  "name",
] as const satisfies readonly SkillCatalogSort[];

export type SkillsBrowseState = {
  /** Market category slug, or "all". */
  category: string;
  trust: SkillCatalogTrust;
  capability: SkillCatalogCapability;
  installed: SkillCatalogInstalled;
  sort: SkillCatalogSort;
  query: string;
};

export const defaultSkillsBrowseState: SkillsBrowseState = {
  category: "all",
  trust: "all",
  capability: "all",
  installed: "all",
  sort: "recommended",
  query: "",
};

/** The URL params this state owns; anything else on the URL is left alone. */
export const SKILLS_BROWSE_PARAM_KEYS = [
  "category",
  "trust",
  "capability",
  "installed",
  "sort",
  "q",
] as const;

type ParamReader = { get(name: string): string | null };

function oneOf<T extends string>(
  value: string | null | undefined,
  options: readonly T[],
): T {
  const trimmed = value?.trim();
  return options.find((option) => option === trimmed) ?? options[0]!;
}

const CATEGORY_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseSkillsBrowseState(params: ParamReader): SkillsBrowseState {
  const category = params.get("category")?.trim().toLowerCase() ?? "";
  return {
    category: CATEGORY_SLUG.test(category) ? category : "all",
    trust: oneOf(params.get("trust"), skillTrustValues),
    capability: oneOf(params.get("capability"), skillCapabilityValues),
    installed: oneOf(params.get("installed"), skillInstalledValues),
    sort: oneOf(params.get("sort"), skillSortValues),
    query: (params.get("q") ?? "").trim().slice(0, SKILLS_QUERY_MAX_LENGTH),
  };
}

/**
 * Writes the state onto a copy of `current`, dropping every default so the
 * plain gallery keeps a clean URL. Returns the query string without the `?`.
 */
export function skillsBrowseSearch(
  state: SkillsBrowseState,
  current?: { toString(): string },
): string {
  const params = new URLSearchParams(current?.toString() ?? "");
  for (const key of SKILLS_BROWSE_PARAM_KEYS) params.delete(key);
  if (state.query) params.set("q", state.query);
  if (state.category !== "all") params.set("category", state.category);
  if (state.trust !== "all") params.set("trust", state.trust);
  if (state.capability !== "all") params.set("capability", state.capability);
  if (state.installed !== "all") params.set("installed", state.installed);
  if (state.sort !== "recommended") params.set("sort", state.sort);
  return params.toString();
}

/**
 * One catalog page. The cursor is only valid for the filters and sort that
 * produced it, so callers pass it for "next page of this same state" only.
 */
export function skillsCatalogRequest(
  state: SkillsBrowseState,
  cursor?: string | null,
): ListSkillsCatalogParams {
  return {
    limit: SKILLS_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(state.query ? { q: state.query } : {}),
    ...(state.category !== "all" ? { category: state.category } : {}),
    ...(state.trust !== "all" ? { trust: state.trust } : {}),
    ...(state.capability !== "all" ? { capability: state.capability } : {}),
    ...(state.installed !== "all" ? { installed: state.installed } : {}),
    ...(state.sort !== "recommended" ? { sort: state.sort } : {}),
  };
}

/** Identity of a result set: two states with the same key share their pages. */
export function skillsBrowseKey(state: SkillsBrowseState) {
  return skillsBrowseSearch(state);
}

export function hasActiveSkillFilters(state: SkillsBrowseState) {
  return (
    Boolean(state.query) ||
    state.category !== "all" ||
    state.trust !== "all" ||
    state.capability !== "all" ||
    state.installed !== "all"
  );
}

/**
 * Whether the server leaves the bounded set (built-ins and the workspace's own
 * skills) out of the first page: those have no market category, capability or
 * community trust level, so such a filter can only match community skills.
 */
export function excludesBoundedSkills(state: SkillsBrowseState) {
  return (
    state.category !== "all" ||
    state.capability !== "all" ||
    state.trust === "verified" ||
    state.trust === "community"
  );
}

type SectionableSkill = { sourceType: string };

export type SkillSections<T> = { builtin: T[]; yours: T[]; community: T[] };

/** Splits loaded items into the gallery's sections, keeping server order. */
export function partitionSkills<T extends SectionableSkill>(
  items: readonly T[],
): SkillSections<T> {
  const sections: SkillSections<T> = { builtin: [], yours: [], community: [] };
  for (const item of items) {
    if (item.sourceType === "builtin") sections.builtin.push(item);
    else if (item.sourceType === "registry_github")
      sections.community.push(item);
    else sections.yours.push(item);
  }
  return sections;
}

/** Appends a page, dropping anything already loaded (pages can overlap). */
export function mergeSkillPages<T extends { catalogId: string }>(
  current: readonly T[],
  next: readonly T[],
): T[] {
  const seen = new Set(current.map((item) => item.catalogId));
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.catalogId)) continue;
    seen.add(item.catalogId);
    merged.push(item);
  }
  return merged;
}

/** Categories worth offering: non-empty ones, plus the selected one always. */
export function visibleSkillCategories(
  categories: readonly SkillCatalogCategory[],
  selected: string,
): SkillCatalogCategory[] {
  return categories.filter(
    (category) => category.count > 0 || category.slug === selected,
  );
}

function humanizeSlug(slug: string) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function skillCategoryName(
  slug: string,
  categories: readonly Pick<SkillCatalogCategory, "slug" | "name">[],
) {
  return (
    categories.find((category) => category.slug === slug)?.name ??
    humanizeSlug(slug)
  );
}

/** The one category a card has room for. */
export function firstSkillCategoryName(
  item: { categories: readonly string[] },
  categories: readonly Pick<SkillCatalogCategory, "slug" | "name">[],
): string | null {
  const slug = item.categories.find((entry) => entry.trim().length > 0);
  return slug ? skillCategoryName(slug.trim(), categories) : null;
}

function trimFraction(value: number) {
  return value.toFixed(1).replace(/\.0$/, "");
}

/** 0 → null (nothing to show), 999 → "999", 1200 → "1.2k", 3400000 → "3.4M". */
export function formatInstallCount(
  count: number | null | undefined,
): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 1) {
    return null;
  }
  const whole = Math.floor(count);
  if (whole < 1000) return String(whole);
  if (whole < 1_000_000) {
    // Floor to one decimal so a count never reads higher than it is.
    return `${trimFraction(Math.floor(whole / 100) / 10)}k`;
  }
  return `${trimFraction(Math.floor(whole / 100_000) / 10)}M`;
}

export function isInvalidCursorError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "INVALID_CURSOR"
  );
}

// Scan flags a reviewer must not miss: fetched-and-run code, prompt injection,
// credential reads, scope escapes and shipped binaries.
const CRITICAL_SKILL_FLAG =
  /pipe-to-shell|base64-exec|injection:override|read-credentials|other-skill-file|binary:executable/;

export function isCriticalSkillFlag(flag: string) {
  return CRITICAL_SKILL_FLAG.test(flag);
}

export function skillFlagLabel(flag: string, labels: Record<string, string>) {
  return labels[flag] ?? flag;
}
