import type {
  ListMarketSkillsRequest,
  MarketSkillCapability,
  MarketSkillSort,
} from "@sourceweft/market-sdk";

import { skillCategoryPath } from "./skills-format";
import { skillsCopy } from "./skills-public-copy";

export const SKILLS_PAGE_SIZE = 24;

export const skillSortOptions = [
  { label: skillsCopy.sortOptions.recommended, value: "recommended" },
  { label: skillsCopy.sortOptions.popular, value: "popular" },
  { label: skillsCopy.sortOptions.new, value: "new" },
  { label: skillsCopy.sortOptions.name, value: "name" },
] as const satisfies readonly { label: string; value: MarketSkillSort }[];

export const skillTrustOptions = [
  { label: skillsCopy.trustOptions.all, value: "all" },
  { label: skillsCopy.trustOptions.verified, value: "verified" },
] as const;

export const skillCapabilityOptions = [
  { label: skillsCopy.capabilityOptions.all, value: "all" },
  { label: skillsCopy.capabilityOptions["prompt-only"], value: "prompt-only" },
  { label: skillsCopy.capabilityOptions.executable, value: "executable" },
] as const satisfies readonly {
  label: string;
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

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function oneOf<T extends string>(
  value: string | undefined,
  options: readonly { value: T }[],
): T {
  return options.find((option) => option.value === value)?.value ?? options[0]!.value;
}

export function parseSkillsBrowseState(
  params: SkillsSearchParams,
  input: { category?: string } = {},
): SkillsBrowseState {
  const cursor = first(params.cursor);
  return {
    capability: oneOf(first(params.type), skillCapabilityOptions),
    category: input.category ?? "all",
    cursor: cursor && cursor.length <= MAX_CURSOR_LENGTH ? cursor : undefined,
    query: (first(params.q) ?? "").slice(0, MAX_QUERY_LENGTH).trim(),
    sort: oneOf(first(params.sort), skillSortOptions),
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
