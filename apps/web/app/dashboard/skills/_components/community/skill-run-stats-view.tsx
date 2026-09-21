import type {
  SkillRunStatsFull,
  SkillRunStatsPublic,
  SkillRunTopError,
} from "@sourceweft/contracts";
import {
  SKILL_RUN_STATS_MIN_RUNS,
  SKILL_RUN_STATS_MIN_WORKSPACES,
} from "@sourceweft/contracts";
import { skillRunStatsCopy as copy } from "./skill-run-stats-copy";

/**
 * Pure presentation of a skill's sandbox run stats: no fetching, no session,
 * no router — so the public skill page can render it from its own data.
 */

export type AvailableSkillRunStats = Extract<
  SkillRunStatsPublic,
  { available: true }
>;

/**
 * A success rate as a whole percent that never rounds up to 100% while a run
 * failed, nor down to 0% while one succeeded.
 */
export function formatSuccessRate(rate: number, locale?: string) {
  const percent =
    rate >= 1
      ? 100
      : rate <= 0
        ? 0
        : Math.min(99, Math.max(1, Math.round(rate * 100)));
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(percent / 100);
}

function formatCount(value: number, locale?: string) {
  return new Intl.NumberFormat(locale).format(value);
}

function formatDate(iso: string, locale?: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale, {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function skillRunErrorLabel(error: SkillRunTopError) {
  return copy.errorLabel(error.errorClass, error.subject);
}

/** "Ran 124 times … · 92% succeeded · Common issue: missing pptxgenjs". */
export function skillRunStatsSentence(
  stats: AvailableSkillRunStats,
  locale?: string,
) {
  const top = stats.topErrors[0];
  return [
    copy.ran(formatCount(stats.runs, locale), stats.windowDays),
    copy.succeeded(formatSuccessRate(stats.successRate, locale)),
    ...(top ? [copy.commonIssue(skillRunErrorLabel(top))] : []),
  ].join(" · ");
}

const boxClass =
  "h-fit rounded-2xl border border-border bg-background p-4 shadow-xs";

/** The public line, for anyone. */
export function SkillRunStatsSummary({
  stats,
  locale,
}: {
  stats: AvailableSkillRunStats;
  locale?: string;
}) {
  return (
    <section aria-label={copy.heading} className={boxClass}>
      <h2 className="text-sm font-semibold text-foreground">{copy.heading}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {skillRunStatsSentence(stats, locale)}
      </p>
    </section>
  );
}

/** Every number, for the skill's verified author and market admins. */
export function SkillRunStatsDetails({
  stats,
  locale,
}: {
  stats: SkillRunStatsFull;
  locale?: string;
}) {
  const runs = formatCount(stats.runs, locale);
  return (
    <section aria-label={copy.heading} className={boxClass}>
      <h2 className="text-sm font-semibold text-foreground">{copy.heading}</h2>
      {stats.runs === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {copy.full.none(stats.windowDays)}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            {copy.ran(runs, stats.windowDays)}
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{copy.full.succeeded}</dt>
            <dd className="text-foreground">
              {copy.full.succeededValue(
                formatCount(stats.successes, locale),
                runs,
                formatSuccessRate(stats.successRate ?? 0, locale),
              )}
            </dd>
            <dt className="text-muted-foreground">{copy.full.workspaces}</dt>
            <dd className="text-foreground">
              {formatCount(stats.workspaces, locale)}
            </dd>
            <dt className="text-muted-foreground">{copy.full.publicLine}</dt>
            <dd className="text-foreground">
              {stats.publiclyVisible
                ? copy.full.shownPublicly
                : copy.full.hiddenPublicly(
                    SKILL_RUN_STATS_MIN_RUNS,
                    SKILL_RUN_STATS_MIN_WORKSPACES,
                  )}
            </dd>
          </dl>
          {stats.topErrors.length > 0 ? (
            <div className="mt-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {copy.full.issues}
              </h3>
              <ul className="mt-1 space-y-1 text-sm">
                {stats.topErrors.map((error) => (
                  <li
                    className="flex justify-between gap-3"
                    key={`${error.errorClass}:${error.subject ?? ""}`}
                  >
                    <span className="min-w-0 truncate text-foreground">
                      {skillRunErrorLabel(error)}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {copy.full.issueCount(formatCount(error.count, locale))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {copy.full.privateNote}
        {stats.computedAt
          ? ` ${copy.full.updated(formatDate(stats.computedAt, locale))}`
          : null}
      </p>
    </section>
  );
}
