import { and, count, eq, gte, inArray } from "drizzle-orm";
import { db, sourceResearchRuns } from "@sourceweft/db";
import type { ResearchStatus } from "@sourceweft/contracts/source-research";
import { RESEARCH_LIMITS } from "./limits";

export interface ResearchRunCountFilter {
  teamId?: string;
  userId?: string;
  statuses?: readonly ResearchStatus[];
  since?: Date;
}

export interface ResearchAdmissionDeps {
  countRuns(filter: ResearchRunCountFilter): Promise<number>;
  hasCredits(): Promise<boolean>;
}

export type ResearchAdmissionResult =
  | { ok: true }
  | {
      ok: false;
      code: "CONCURRENCY_LIMIT" | "DAILY_LIMIT" | "INSUFFICIENT_CREDITS";
      retryAfterSeconds?: number;
    };

const ACTIVE_STATUSES = ["queued", "running"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Counts research_runs rows matching the filter. */
export async function countResearchRuns(
  filter: ResearchRunCountFilter,
): Promise<number> {
  const conditions = [
    filter.teamId ? eq(sourceResearchRuns.teamId, filter.teamId) : undefined,
    filter.userId
      ? eq(sourceResearchRuns.createdByUserId, filter.userId)
      : undefined,
    filter.statuses
      ? inArray(sourceResearchRuns.status, [...filter.statuses])
      : undefined,
    filter.since ? gte(sourceResearchRuns.createdAt, filter.since) : undefined,
  ].filter((condition) => condition !== undefined);
  const [row] = await db
    .select({ value: count() })
    .from(sourceResearchRuns)
    .where(and(...conditions));
  return row?.value ?? 0;
}

/** Order is fixed (credits, concurrency, daily) so error codes are stable. */
export async function admitResearch(
  input: { teamId: string; workspaceId: string; userId: string; now?: Date },
  deps: ResearchAdmissionDeps,
): Promise<ResearchAdmissionResult> {
  if (!(await deps.hasCredits())) {
    return { ok: false, code: "INSUFFICIENT_CREDITS" };
  }
  const [userActive, teamActive] = await Promise.all([
    deps.countRuns({
      userId: input.userId,
      teamId: input.teamId,
      statuses: ACTIVE_STATUSES,
    }),
    deps.countRuns({ teamId: input.teamId, statuses: ACTIVE_STATUSES }),
  ]);
  if (
    userActive >= RESEARCH_LIMITS.perUserConcurrent ||
    teamActive >= RESEARCH_LIMITS.perTeamConcurrent
  ) {
    return { ok: false, code: "CONCURRENCY_LIMIT" };
  }
  const since = new Date((input.now ?? new Date()).getTime() - DAY_MS);
  const daily = await deps.countRuns({
    userId: input.userId,
    teamId: input.teamId,
    since,
  });
  if (daily >= RESEARCH_LIMITS.perUserPerDay) {
    return { ok: false, code: "DAILY_LIMIT" };
  }
  return { ok: true };
}
