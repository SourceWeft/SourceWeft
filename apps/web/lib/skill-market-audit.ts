import type {
  ListSkillMarketAdminSkillsResponse,
  ListSkillMarketEventsResponse,
  ReinferSkillCategoriesResponse,
  RestoreSkillRepoToMarketResponse,
  SkillMarketAdminMeResponse,
  SkillMarketAdminStandingFilter,
  SkillMarketStanding,
} from "@sourceweft/contracts";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * The market admin's audit trail and all-skills list (skill-marketplace-plan
 * §17.1), the "am I a market admin" check, and an author restoring a
 * repository they removed. Every `/admin` route but `me` answers 403 to
 * anyone who is not a market admin.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

const ADMIN_BASE = "/v1/skills/registry/admin";

function skillPath(skillId: string) {
  return `${ADMIN_BASE}/skills/${encodeURIComponent(skillId)}`;
}

/** Whether to show market admin entry points; grants nothing by itself. */
export function getSkillMarketAdminMe() {
  return http.get<SkillMarketAdminMeResponse>(`${ADMIN_BASE}/me`);
}

export type SkillMarketAdminSkillsFilters = {
  q?: string;
  standing?: SkillMarketAdminStandingFilter;
  featured?: boolean;
  verified?: boolean;
  claimed?: boolean;
  flagged?: boolean;
  reported?: boolean;
};

/** The query string the all-skills route reads; unset filters are left out. */
export function skillMarketAdminSkillsQuery(
  filters: SkillMarketAdminSkillsFilters,
  page: { cursor?: string | null; limit?: number } = {},
): string {
  const query = new URLSearchParams();
  const q = filters.q?.trim();
  if (q) query.set("q", q.slice(0, 200));
  if (filters.standing) query.set("standing", filters.standing);
  for (const key of [
    "featured",
    "verified",
    "claimed",
    "flagged",
    "reported",
  ] as const) {
    const value = filters[key];
    if (value !== undefined) query.set(key, String(value));
  }
  if (page.cursor) query.set("cursor", page.cursor);
  if (page.limit) query.set("limit", String(page.limit));
  const search = query.toString();
  return search ? `?${search}` : "";
}

export function listSkillMarketAdminSkills(
  filters: SkillMarketAdminSkillsFilters,
  page: { cursor?: string | null; limit?: number } = {},
) {
  return http.get<ListSkillMarketAdminSkillsResponse>(
    `${ADMIN_BASE}/skills${skillMarketAdminSkillsQuery(filters, page)}`,
  );
}

/** Every market event, newest first, a page at a time. */
export function listSkillMarketEvents(
  page: { cursor?: string | null; limit?: number } = {},
) {
  const query = new URLSearchParams();
  if (page.cursor) query.set("cursor", page.cursor);
  if (page.limit) query.set("limit", String(page.limit));
  const search = query.toString();
  return http.get<ListSkillMarketEventsResponse>(
    `${ADMIN_BASE}/events${search ? `?${search}` : ""}`,
  );
}

/** One skill's history, its repository's claim events included. */
export function listSkillEvents(skillId: string, limit?: number) {
  return http.get<ListSkillMarketEventsResponse>(
    `${skillPath(skillId)}/events${limit ? `?limit=${limit}` : ""}`,
  );
}

/** One skill's categories from its text again, even an admin's pick. */
export function reinferSkillCategories(skillId: string) {
  return http.post<SkillMarketStanding>(
    `${skillPath(skillId)}/reinfer-categories`,
    {},
  );
}

/** Every inferred skill's categories again; an admin's pick is left alone. */
export function reinferAllSkillCategories() {
  return http.post<ReinferSkillCategoriesResponse>(
    `${ADMIN_BASE}/reinfer-categories`,
    {},
  );
}

/** The author undoes "remove from SourceWeft" for a claimed repository. */
export function restoreClaimedRepoToMarket(
  workspaceId: string,
  claimId: string,
) {
  return http.post<RestoreSkillRepoToMarketResponse>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/skills/claims/${encodeURIComponent(claimId)}/restore-to-market`,
    {},
  );
}

/** The HTTP status behind a failed call, when there was one. */
export function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

export function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : fallback;
}
