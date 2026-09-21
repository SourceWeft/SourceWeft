import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillRunEvents,
  skillRunStats,
  skillVersions,
} from "@sourceweft/db";
import {
  SKILL_RUN_STATS_MIN_RUNS,
  SKILL_RUN_STATS_MIN_WORKSPACES,
  SKILL_RUN_STATS_WINDOW_DAYS,
  type SkillRunStatsFull,
  type SkillRunStatsPublic,
} from "@sourceweft/contracts";
import { config } from "../../../shared/config";
import { publicMarketSkillCondition } from "./read-repository";
import { logger } from "../../../shared/logger";
import type { EnabledSkillDescriptor } from "../types";
import {
  classifySkillRun,
  skillNamesReferencedByCommand,
  skillRunOutcome,
  type SkillRunClassification,
} from "./run-capture";

/**
 * Sandbox run statistics of market skills (skill-marketplace-plan §17.5).
 *
 * The sandbox records one `skill_run_events` row per registry skill a finished
 * command ran; the scheduler folds the last 30 days into `skill_run_stats`; the
 * public page reads that, and shows it only past a floor of runs and
 * workspaces. No row holds a command, an argument, a path or any output, and a
 * workspace appears only as a keyed hash.
 */

/** Events older than this are deleted; stats only ever read 30 days. */
const RUN_EVENT_RETENTION_DAYS = 90;
const PRUNE_BATCH_SIZE = 5_000;
// One tick deletes at most this many batches; the next tick continues.
const PRUNE_MAX_BATCHES = 20;
const TOP_ERRORS_LIMIT = 5;

let workspaceHashKey: Buffer | null = null;

/**
 * The key a workspace id is hashed under: derived from the auth secret, so it
 * exists wherever the API runs and needs no setting of its own, and a
 * database dump alone cannot be matched back to workspace ids.
 */
function runStatsWorkspaceKey() {
  workspaceHashKey ??= createHash("sha256")
    .update("sourceweft:skill-run-stats:workspace:v1\0")
    .update(config.auth.secret)
    .digest();
  return workspaceHashKey;
}

export function skillRunWorkspaceHash(workspaceId: string): string {
  return createHmac("sha256", runStatsWorkspaceKey())
    .update(workspaceId)
    .digest("hex");
}

/**
 * Records one run per skill version. Registry skills only: the versions are
 * looked up and a builtin or custom skill's version is dropped here, whatever
 * the caller passed. Resolves when written; callers on the tool path use
 * `recordSkillRunsInBackground` instead.
 */
export async function recordSkillRuns(input: {
  workspaceId: string;
  skillVersionIds: readonly string[];
  exitCode: number | null;
  durationMs: number;
  classification: SkillRunClassification;
}): Promise<number> {
  const versionIds = [...new Set(input.skillVersionIds)];
  if (versionIds.length === 0) return 0;
  const versions = await db
    .select({ id: skillVersions.id, skillId: skillVersions.skillId })
    .from(skillVersions)
    .innerJoin(skillDefinitions, eq(skillDefinitions.id, skillVersions.skillId))
    .where(
      and(
        inArray(skillVersions.id, versionIds),
        eq(skillDefinitions.sourceType, "registry_github"),
      ),
    );
  if (versions.length === 0) return 0;
  const workspaceHash = skillRunWorkspaceHash(input.workspaceId);
  const durationMs = Math.max(
    0,
    Math.min(Math.round(input.durationMs), 2_147_483_647),
  );
  await db.insert(skillRunEvents).values(
    versions.map((version) => ({
      id: randomUUID(),
      skillId: version.skillId,
      skillVersionId: version.id,
      workspaceHash,
      exitCode: input.exitCode,
      durationMs,
      errorClass: input.classification.errorClass,
      errorSubject:
        input.classification.errorClass === "missing_dependency"
          ? input.classification.errorSubject
          : null,
    })),
  );
  return versions.length;
}

/**
 * `recordSkillRuns` for the tool path: never awaited, never thrown. A lost
 * event costs one run from a statistic; a slow or failing write must cost the
 * command nothing.
 */
export function recordSkillRunsInBackground(
  input: Parameters<typeof recordSkillRuns>[0],
): void {
  void recordSkillRuns(input).catch((error: unknown) => {
    logger.warn("Skill run event was not recorded", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export type SkillRunObserver = {
  /** Synchronous and never throws; any write happens in the background. */
  commandFinished(input: {
    command: string;
    durationMs: number;
    finished: Parameters<typeof skillRunOutcome>[0];
  }): void;
};

/**
 * The sandbox `execute` hook of one turn. After each command it checks which
 * of the turn's staged skills the command ran (`/skills/<name>/…`) and, for
 * registry skills only, records the outcome. The command and its output are
 * read here and dropped here.
 */
export function createSkillRunObserver(input: {
  workspaceId: string;
  stagedSkills: () => ReadonlyMap<
    string,
    Pick<EnabledSkillDescriptor, "sourceType" | "skillVersionId">
  >;
  record?: typeof recordSkillRunsInBackground;
}): SkillRunObserver {
  const record = input.record ?? recordSkillRunsInBackground;
  return {
    commandFinished({ command, durationMs, finished }) {
      try {
        const staged = input.stagedSkills();
        if (staged.size === 0) return;
        const names = skillNamesReferencedByCommand(
          command,
          new Set(staged.keys()),
        );
        const skillVersionIds = names.flatMap((name) => {
          const skill = staged.get(name);
          return skill?.sourceType === "registry_github" && skill.skillVersionId
            ? [skill.skillVersionId]
            : [];
        });
        if (skillVersionIds.length === 0) return;
        const outcome = skillRunOutcome(finished);
        if (!outcome) return;
        record({
          workspaceId: input.workspaceId,
          skillVersionIds,
          exitCode: outcome.kind === "result" ? outcome.exitCode : null,
          durationMs,
          classification: classifySkillRun(outcome),
        });
      } catch (error) {
        logger.warn("Skill run was not observed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/**
 * Recomputes `skill_run_stats` over the last 30 days in one statement: runs,
 * successes, distinct workspaces and the five most common errors per skill,
 * and deletes the rows of skills with no run left in the window. Then prunes
 * events past retention, in batches.
 */
export async function refreshSkillRunStats(): Promise<{
  skills: number;
  cleared: number;
  pruned: number;
}> {
  const window = sql`now() - make_interval(days => ${SKILL_RUN_STATS_WINDOW_DAYS})`;
  const result = await db.execute<{ upserted: number; cleared: number }>(sql`
    with recent as (
      select skill_id, workspace_hash, error_class, error_subject
      from skill_run_events
      where created_at >= ${window}
    ),
    totals as (
      select
        skill_id,
        count(*)::int as runs,
        (count(*) filter (where error_class is null))::int as successes,
        count(distinct workspace_hash)::int as workspaces
      from recent
      group by skill_id
    ),
    errors as (
      select
        skill_id,
        error_class,
        error_subject,
        count(*)::int as n,
        row_number() over (
          partition by skill_id
          order by count(*) desc, error_class, error_subject nulls last
        ) as position
      from recent
      where error_class is not null
      group by skill_id, error_class, error_subject
    ),
    top_errors as (
      select
        skill_id,
        jsonb_agg(
          jsonb_build_object(
            'errorClass', error_class,
            'subject', error_subject,
            'count', n
          )
          order by position
        ) as top_errors
      from errors
      where position <= ${TOP_ERRORS_LIMIT}
      group by skill_id
    ),
    upserted as (
      insert into skill_run_stats
        (skill_id, runs, successes, workspaces, top_errors, computed_at)
      select
        t.skill_id,
        t.runs,
        t.successes,
        t.workspaces,
        coalesce(e.top_errors, '[]'::jsonb),
        now()
      from totals t
      left join top_errors e on e.skill_id = t.skill_id
      on conflict (skill_id) do update set
        runs = excluded.runs,
        successes = excluded.successes,
        workspaces = excluded.workspaces,
        top_errors = excluded.top_errors,
        computed_at = excluded.computed_at
      returning skill_id
    ),
    cleared as (
      delete from skill_run_stats s
      where not exists (select 1 from totals t where t.skill_id = s.skill_id)
      returning s.skill_id
    )
    select
      (select count(*) from upserted)::int as upserted,
      (select count(*) from cleared)::int as cleared
  `);
  const counts = result.rows[0];

  let pruned = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const deleted = await db.execute(sql`
      delete from skill_run_events
      where id in (
        select id from skill_run_events
        where created_at < now() - make_interval(days => ${RUN_EVENT_RETENTION_DAYS})
        limit ${PRUNE_BATCH_SIZE}
      )
    `);
    const count = deleted.rowCount ?? 0;
    pruned += count;
    if (count < PRUNE_BATCH_SIZE) break;
  }
  return {
    skills: Number(counts?.upserted ?? 0),
    cleared: Number(counts?.cleared ?? 0),
    pruned,
  };
}

type StatsRow = typeof skillRunStats.$inferSelect;

async function findStatsRow(skillId: string): Promise<StatsRow | null> {
  const [row] = await db
    .select()
    .from(skillRunStats)
    .where(eq(skillRunStats.skillId, skillId))
    .limit(1);
  return row ?? null;
}

export function meetsPublicRunStatsThreshold(row: {
  runs: number;
  workspaces: number;
}): boolean {
  return (
    row.runs >= SKILL_RUN_STATS_MIN_RUNS &&
    row.workspaces >= SKILL_RUN_STATS_MIN_WORKSPACES
  );
}

/**
 * What the public page may show: the numbers once they clear both floors,
 * otherwise `available: false` and nothing else — not the run count, not the
 * workspace count.
 */
export function publicRunStats(row: StatsRow | null): SkillRunStatsPublic {
  if (!row || !meetsPublicRunStatsThreshold(row)) {
    return { available: false };
  }
  return {
    available: true,
    runs: row.runs,
    successRate: row.successes / row.runs,
    workspaces: row.workspaces,
    topErrors: row.topErrors.slice(0, TOP_ERRORS_LIMIT),
    windowDays: SKILL_RUN_STATS_WINDOW_DAYS,
  };
}

export function fullRunStats(
  skillId: string,
  row: StatsRow | null,
): SkillRunStatsFull {
  const runs = row?.runs ?? 0;
  const successes = row?.successes ?? 0;
  return {
    skillId,
    runs,
    successes,
    successRate: runs > 0 ? successes / runs : null,
    workspaces: row?.workspaces ?? 0,
    topErrors: (row?.topErrors ?? []).slice(0, TOP_ERRORS_LIMIT),
    windowDays: SKILL_RUN_STATS_WINDOW_DAYS,
    publiclyVisible: row ? meetsPublicRunStatsThreshold(row) : false,
    computedAt: row?.computedAt.toISOString() ?? null,
  };
}

export async function getPublicSkillRunStats(
  skillId: string,
): Promise<SkillRunStatsPublic> {
  return publicRunStats(await findStatsRow(skillId));
}

export async function getFullSkillRunStats(
  skillId: string,
): Promise<SkillRunStatsFull> {
  return fullRunStats(skillId, await findStatsRow(skillId));
}

/**
 * The registry skill a slug names, and whether it is on the public market by
 * the market's one public predicate. Null for any other skill.
 */
export async function findRunStatsSkill(
  by: { slug: string } | { skillId: string },
): Promise<{ id: string; isPublic: boolean } | null> {
  const [row] = await db
    .select({
      id: skillDefinitions.id,
      isPublic: sql<boolean>`exists (
        select 1 from ${skillVersions}
        where ${and(eq(skillVersions.skillId, skillDefinitions.id), publicMarketSkillCondition())}
      )`,
    })
    .from(skillDefinitions)
    .where(
      and(
        "slug" in by
          ? eq(skillDefinitions.slug, by.slug)
          : eq(skillDefinitions.id, by.skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
      ),
    )
    .limit(1);
  return row ? { id: row.id, isPublic: row.isPublic === true } : null;
}
