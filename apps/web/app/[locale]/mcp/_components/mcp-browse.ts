import type { ListMarketMcpRequest } from "@sourceweft/market-sdk";

import { mcpCategoryPath } from "./mcp-display";

export const MCP_PAGE_SIZE = 24;

export const mcpTrustOptions = [
  { label: "Any trust", value: "all" },
  { label: "Official", value: "official" },
  { label: "Verified", value: "verified" },
] as const;

export const mcpRuntimeOptions = [
  { label: "Any runtime", value: "all" },
  { label: "Web", value: "web" },
  { label: "Desktop", value: "desktop" },
] as const;

export type McpTrustFilter = (typeof mcpTrustOptions)[number]["value"];
export type McpRuntimeFilter = (typeof mcpRuntimeOptions)[number]["value"];

export type McpBrowseState = {
  /** Category slug, or "all". Comes from the route on /mcp/category/[slug]. */
  category: string;
  cursor?: string;
  query: string;
  runtime: McpRuntimeFilter;
  trust: McpTrustFilter;
  /** Explicit "view all" listing without any other narrowing. */
  view: boolean;
};

export type McpSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function oneOf<T extends string>(
  value: string | undefined,
  options: readonly { value: T }[],
): T {
  return options.find((option) => option.value === value)?.value ?? options[0]!.value;
}

export function parseMcpBrowseState(
  params: McpSearchParams,
  input: { category?: string } = {},
): McpBrowseState {
  return {
    category: input.category ?? "all",
    cursor: first(params.cursor),
    query: first(params.q) ?? "",
    runtime: oneOf(first(params.runtime), mcpRuntimeOptions),
    trust: oneOf(first(params.trust), mcpTrustOptions),
    view: first(params.view) === "all",
  };
}

export function isMcpListView(state: McpBrowseState) {
  return (
    state.view ||
    Boolean(state.query) ||
    Boolean(state.cursor) ||
    state.category !== "all" ||
    state.trust !== "all" ||
    state.runtime !== "all"
  );
}

/** Whether the list only narrows by category, so facet counts are exact. */
export function hasOnlyCategoryFacet(state: McpBrowseState) {
  return state.trust === "all" && state.runtime === "all";
}

function runtimeRequest(runtime: McpRuntimeFilter) {
  if (runtime === "web") return { desktopOnly: false };
  if (runtime === "desktop") return { desktopOnly: true };
  return { includeDesktopOnly: true };
}

export function mcpListRequest(state: McpBrowseState): ListMarketMcpRequest {
  return {
    ...runtimeRequest(state.runtime),
    ...(state.category !== "all" ? { category: state.category } : {}),
    ...(state.trust === "official" ? { official: true } : {}),
    ...(state.trust === "verified" ? { verified: true } : {}),
    ...(state.query ? { query: state.query } : {}),
    ...(state.cursor ? { cursor: state.cursor } : {}),
    limit: MCP_PAGE_SIZE,
  };
}

export function mcpCountRequest(state: McpBrowseState) {
  return {
    ...runtimeRequest(state.runtime),
    ...(state.query ? { query: state.query } : {}),
  };
}

/**
 * Builds a listing URL from the current state plus a patch. The category is a
 * route segment, not a query param, so category pages stay indexable; facets
 * ride along as query params. Any change other than an explicit cursor resets
 * pagination, because a cursor is only valid for the filter set that made it.
 */
export function mcpBrowseHref(
  state: McpBrowseState,
  patch: Partial<McpBrowseState> = {},
) {
  const next: McpBrowseState = { ...state, cursor: undefined, ...patch };
  const path = next.category === "all" ? "/mcp" : mcpCategoryPath(next.category);
  const params = new URLSearchParams();
  if (next.query) params.set("q", next.query);
  if (next.trust !== "all") params.set("trust", next.trust);
  if (next.runtime !== "all") params.set("runtime", next.runtime);
  if (next.cursor) params.set("cursor", next.cursor);
  if (params.size === 0 && path === "/mcp" && next.view) {
    params.set("view", "all");
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export const defaultMcpBrowseState: McpBrowseState = {
  category: "all",
  query: "",
  runtime: "all",
  trust: "all",
  view: false,
};
