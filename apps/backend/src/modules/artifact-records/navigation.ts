import { and, eq, gte, sql } from "drizzle-orm";
import { db, teamAuditLogs } from "@sourceweft/db";
import { jobsRedisClient } from "../../shared/queue";

/** The closed audit action a navigation report is recorded under. */
export const NAVIGATION_ATTEMPT_ACTION = "artifact.page_navigation_attempt";

/** One recorded report per viewer and version in this many seconds. */
export const NAVIGATION_REPORT_WINDOW_SECONDS = 60;

/** How far back "recently" reaches when the host shows the count. */
export const NAVIGATION_ATTEMPT_WINDOW_DAYS = 7;

/**
 * A fixed window that admits the first call for a key and refuses the rest
 * until it expires. Shared Redis, so the limit holds across api replicas.
 */
export type NavigationReportLimiter = {
  allow(key: string): Promise<boolean>;
};

export const redisNavigationReportLimiter: NavigationReportLimiter = {
  async allow(key) {
    const redis = await jobsRedisClient();
    const result = await redis.set(
      `artifact-records:navigation:${key}`,
      "1",
      "EX",
      NAVIGATION_REPORT_WINDOW_SECONDS,
      "NX",
    );
    return result === "OK";
  },
};

/**
 * Reports recorded for one version in the last seven days. The team and
 * created_at bounds let `team_audit_logs_team_created_idx` narrow the scan
 * before the action, artifact and version are matched.
 */
export async function countNavigationAttempts(input: {
  teamId: string;
  artifactId: string;
  versionId: string;
  now?: Date;
}): Promise<number> {
  const since = new Date(
    (input.now ?? new Date()).getTime() -
      NAVIGATION_ATTEMPT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(teamAuditLogs)
    .where(
      and(
        eq(teamAuditLogs.teamId, input.teamId),
        gte(teamAuditLogs.createdAt, since),
        eq(teamAuditLogs.action, NAVIGATION_ATTEMPT_ACTION),
        eq(teamAuditLogs.targetId, input.artifactId),
        sql`${teamAuditLogs.metadata}->>'versionId' = ${input.versionId}`,
      ),
    );
  return row?.count ?? 0;
}
