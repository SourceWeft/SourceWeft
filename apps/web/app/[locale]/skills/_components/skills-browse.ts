import type {
  ListMarketSkillsRequest,
  MarketSkillCapability,
  MarketSkillSort,
} from "@sourceweft/market-sdk";

import { skillCategoryPath } from "./skills-format";

export const SKILLS_PAGE_SIZE = 24;

// Values only: the listing labels each one from the `publicSkills.sortOptions`
// / `trustOptions` / `capabilityOptions` messages.
export const skillSortOptions = [
  { value: "recommended" },
  { value: "popular" },
  { value: "stars" },
  { value: "new" },
  { value: "name" },
] as const satisfies readonly { value: MarketSkillSort }[];

export const skillTrustOptions = [
  { value: "all" },
  { value: "featured" },
  { value: "verified" },
] as const;

export const skillCapabilityOptions = [
  { value: "all" },
  { value: "prompt-only" },
  { value: "executable" },
] as const satisfies readonly {
  value: "all" | MarketSkillCapability;
}[];

export type SkillSortOption = (typeof skillSortOptions)[number]["value"];
export type SkillTrustFilter = (typeof skillTrustOptions)[number]["value"];
export type SkillCapabilityFilter =
  (typeof skillCapabilityOptions)[number]["value"];

export type SkillsBrowseState = {
  capability: SkillCapabilityFilter;
  /** Category slug, or "all". Comes from the route on /skills/category/[slug]. */
  category: string;
  cursor?: string;
  query: string;
  sort: SkillSortOption;
  trust: SkillTrustFilter;
  /** Explicit "view all" listing without any other narrowing. */
  view: boolean;
};

export type SkillsSearchParams = Record<string, string | string[] | undefined>;

// The API rejects anything longer, and the swallowing list wrapper would turn
// that rejection into an empty page.
const MAX_QUERY_LENGTH = 200;
const MAX_CURSOR_LENGTH = 1024;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/**
 * The sort a cursor belongs to, or undefined for anything the market did not
 * hand out. A cursor is base64url JSON of `[sort, ...keys, id]`; the name
 * sort's older form was the bare `[name, id]`.
 */
function cursorSort(cursor: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const isId = (value: unknown) =>
    typeof value === "string" && value.length > 0;
  const isNonNegativeInt = (value: unknown) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647;
  const isMicros = (value: unknown) =>
    typeof value === "string" && /^-?\d{1,18}$/.test(value);
  if (parsed.length === 2) {
    return typeof parsed[0] === "string" && isId(parsed[1])
      ? "name"
      : undefined;
  }
  const [sort, ...keys] = parsed;
  switch (sort) {
    case "name":
      return keys.length === 2 && typeof keys[0] === "string" && isId(keys[1])
        ? sort
        : undefined;
    case "popular":
    case "stars":
      return keys.length === 2 && isNonNegativeInt(keys[0]) && isId(keys[1])
        ? sort
        : undefined;
    case "new":
      return keys.length === 2 && isMicros(keys[0]) && isId(keys[1])
        ? sort
        : undefined;
    case "recommended":
      return keys.length === 6 &&
        keys[0] === "featured-rank" &&
        typeof keys[1] === "boolean" &&
        typeof keys[2] === "boolean" &&
        isNonNegativeInt(keys[3]) &&
        isMicros(keys[4]) &&
        isId(keys[5])
        ? sort
        : undefined;
    default:
      return undefined;
  }
}

// Crawlers replay stale and mangled cursors, and the API answers those with a
// 400 that the swallowing list wrapper turns into an empty page served as 200.
// Only a cursor that is well-formed and belongs to the current sort goes
// through; anything else starts the listing from its first page.
function cursorFor(value: string | undefined, sort: SkillSortOption) {
  return value &&
    value.length <= MAX_CURSOR_LENGTH &&
    CURSOR_PATTERN.test(value) &&
    cursorSort(value) === sort
    ? value
    : undefined;
}

function oneOf<T extends string>(
  value: string | undefined,
  options: readonly { value: T }[],
): T {
  return (
    options.find((option) => option.value === value)?.value ?? options[0]!.value
  );
}

export function parseSkillsBrowseState(
  params: SkillsSearchParams,
  input: { category?: string } = {},
): SkillsBrowseState {
  const sort = oneOf(first(params.sort), skillSortOptions);
  return {
    capability: oneOf(first(params.type), skillCapabilityOptions),
    category: input.category ?? "all",
    cursor: cursorFor(first(params.cursor), sort),
    query: (first(params.q) ?? "").slice(0, MAX_QUERY_LENGTH).trim(),
    sort,
    trust: oneOf(first(params.trust), skillTrustOptions),
    view: first(params.view) === "all",
  };
}

/** Whether anything narrows the catalog beyond the category in the route. */
export function isSkillsNarrowed(state: SkillsBrowseState) {
  return (
    Boolean(state.query) ||
    Boolean(state.cursor) ||
    state.trust !== "all" ||
    state.capability !== "all" ||
    state.sort !== "recommended"
  );
}

export function isSkillsListView(state: SkillsBrowseState) {
  return state.view || state.category !== "all" || isSkillsNarrowed(state);
}

/** Whether the list only narrows by category, so the category counts are exact. */
export function hasOnlyCategoryFacet(state: SkillsBrowseState) {
  return !state.query && state.trust === "all" && state.capability === "all";
}

export function skillsListRequest(
  state: SkillsBrowseState,
): ListMarketSkillsRequest {
  return {
    ...(state.category !== "all" ? { category: state.category } : {}),
    ...(state.trust === "verified" ? { verified: true } : {}),
    ...(state.trust === "featured" ? { featured: true } : {}),
    ...(state.capability !== "all" ? { capability: state.capability } : {}),
    ...(state.query ? { query: state.query } : {}),
    ...(state.cursor ? { cursor: state.cursor } : {}),
    limit: SKILLS_PAGE_SIZE,
    sort: state.sort,
  };
}

/**
 * Builds a listing URL from the current state plus a patch. The category is a
 * route segment, not a query param, so category pages stay indexable; facets
 * ride along as query params. Any change other than an explicit cursor resets
 * pagination, because a cursor is only valid for the sort and filter set that
 * made it.
 */
export function skillsBrowseHref(
  state: SkillsBrowseState,
  patch: Partial<SkillsBrowseState> = {},
) {
  const next: SkillsBrowseState = { ...state, cursor: undefined, ...patch };
  const path =
    next.category === "all" ? "/skills" : skillCategoryPath(next.category);
  const params = new URLSearchParams();
  if (next.query) params.set("q", next.query);
  if (next.sort !== "recommended") params.set("sort", next.sort);
  if (next.trust !== "all") params.set("trust", next.trust);
  if (next.capability !== "all") params.set("type", next.capability);
  if (next.cursor) params.set("cursor", next.cursor);
  if (params.size === 0 && path === "/skills" && next.view) {
    params.set("view", "all");
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export const defaultSkillsBrowseState: SkillsBrowseState = {
  capability: "all",
  category: "all",
  query: "",
  sort: "recommended",
  trust: "all",
  view: false,
};
