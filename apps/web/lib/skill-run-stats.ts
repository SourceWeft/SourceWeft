import type {
  SkillRunStatsFull,
  SkillRunStatsPublic,
} from "@sourceweft/contracts";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * Sandbox run statistics of a community skill (§17.5). The public answer is
 * anonymous and says nothing below its floor of runs and workspaces; the full
 * one is for the skill's verified author and market admins only. Counts only —
 * the API never stored a command or its output.
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

export type { SkillRunStatsFull, SkillRunStatsPublic };

function runStatsPath(slug: string) {
  return `/v1/skills/${encodeURIComponent(slug)}/run-stats`;
}

export function getPublicSkillRunStats(
  slug: string,
): Promise<SkillRunStatsPublic> {
  return http.get(runStatsPath(slug));
}

/** 401 signed out, 403 not the author or an admin, 404 not visible to them. */
export function getFullSkillRunStats(slug: string): Promise<SkillRunStatsFull> {
  return http.get(`${runStatsPath(slug)}?full=1`);
}

/** The route's way of saying "not for you" or "not there", not a failure. */
export function isSkillRunStatsUnavailable(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 || status === 404;
}

export type SkillRunStatsView =
  | { kind: "full"; stats: SkillRunStatsFull }
  | { kind: "public"; stats: Extract<SkillRunStatsPublic, { available: true }> }
  | { kind: "none" };

/**
 * What this viewer gets to see. Both requests go out together: the full one
 * answers for the author and admins (one route covers both, so the admin-only
 * route by id is not needed here), and everyone else falls back to the public
 * answer without waiting for a second round trip. An error other than "not
 * for you" is thrown — the caller renders nothing either way.
 */
export async function loadSkillRunStatsView(
  slug: string,
): Promise<SkillRunStatsView> {
  const [full, publicStats] = await Promise.allSettled([
    getFullSkillRunStats(slug),
    getPublicSkillRunStats(slug),
  ]);
  if (full.status === "fulfilled") {
    return { kind: "full", stats: full.value };
  }
  if (!isSkillRunStatsUnavailable(full.reason)) {
    throw full.reason;
  }
  if (publicStats.status === "rejected") {
    if (isSkillRunStatsUnavailable(publicStats.reason)) {
      return { kind: "none" };
    }
    throw publicStats.reason;
  }
  return publicStats.value.available
    ? { kind: "public", stats: publicStats.value }
    : { kind: "none" };
}
