import type {
  SkillRunStatsFull,
  SkillRunStatsPublic,
  SkillRunTopError,
} from "@sourceweft/contracts";
import {
  SKILL_RUN_STATS_MIN_RUNS,
  SKILL_RUN_STATS_MIN_WORKSPACES,
} from "@sourceweft/contracts";
import { useLocale, useTranslations } from "next-intl";

/**
 * Pure presentation of a skill's sandbox run stats: no fetching, no session,
 * no router. Helpers take the `dashboardSkillRunStats` translator.
 */

type Translate = ReturnType<typeof useTranslations>;

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

/** An error class in words; an unknown class reads as "other errors". */
export function skillRunErrorLabel(error: SkillRunTopError, t: Translate) {
  if (error.errorClass === "missing_dependency" && error.subject) {
    return t("errors.missing_dependency_named", { subject: error.subject });
  }
  const key = `errors.${error.errorClass}`;
  return t.has(key) ? t(key) : t("errors.other");
}

/** "Ran 124 times … · 92% succeeded · Common issue: missing pptxgenjs". */
export function skillRunStatsSentence(
  stats: AvailableSkillRunStats,
  t: Translate,
  locale?: string,
) {
  const top = stats.topErrors[0];
  return [
    t("ran", { runs: stats.runs, days: stats.windowDays }),
    t("succeeded", { percent: formatSuccessRate(stats.successRate, locale) }),
    ...(top
      ? [t("commonIssue", { label: skillRunErrorLabel(top, t) })]
      : []),
  ].join(" · ");
}

const boxClass =
  "h-fit rounded-2xl border border-border bg-background p-4 shadow-xs";

/** The public line, for anyone. */
export function SkillRunStatsSummary({
  stats,
}: {
  stats: AvailableSkillRunStats;
}) {
  const t = useTranslations("dashboardSkillRunStats");
  const locale = useLocale();
  return (
    <section aria-label={t("heading")} className={boxClass}>
      <h2 className="text-sm font-semibold text-foreground">{t("heading")}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {skillRunStatsSentence(stats, t, locale)}
      </p>
    </section>
  );
}

/** Every number, for the skill's verified author and market admins. */
export function SkillRunStatsDetails({
  stats,
}: {
  stats: SkillRunStatsFull;
}) {
  const t = useTranslations("dashboardSkillRunStats");
  const locale = useLocale();
  return (
    <section aria-label={t("heading")} className={boxClass}>
      <h2 className="text-sm font-semibold text-foreground">{t("heading")}</h2>
      {stats.runs === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("full.none", { days: stats.windowDays })}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("ran", { runs: stats.runs, days: stats.windowDays })}
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t("full.succeeded")}</dt>
            <dd className="text-foreground">
              {t("full.succeededValue", {
                successes: stats.successes,
                runs: stats.runs,
                percent: formatSuccessRate(stats.successRate ?? 0, locale),
              })}
            </dd>
            <dt className="text-muted-foreground">{t("full.workspaces")}</dt>
            <dd className="text-foreground">
              {new Intl.NumberFormat(locale).format(stats.workspaces)}
            </dd>
            <dt className="text-muted-foreground">{t("full.publicLine")}</dt>
            <dd className="text-foreground">
              {stats.publiclyVisible
                ? t("full.shownPublicly")
                : t("full.hiddenPublicly", {
                    minRuns: SKILL_RUN_STATS_MIN_RUNS,
                    minWorkspaces: SKILL_RUN_STATS_MIN_WORKSPACES,
                  })}
            </dd>
          </dl>
          {stats.topErrors.length > 0 ? (
            <div className="mt-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("full.issues")}
              </h3>
              <ul className="mt-1 space-y-1 text-sm">
                {stats.topErrors.map((error) => (
                  <li
                    className="flex justify-between gap-3"
                    key={`${error.errorClass}:${error.subject ?? ""}`}
                  >
                    <span className="min-w-0 truncate text-foreground">
                      {skillRunErrorLabel(error, t)}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {t("full.issueCount", { count: error.count })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {t("full.privateNote")}
        {stats.computedAt
          ? ` ${t("full.updated", { when: formatDate(stats.computedAt, locale) })}`
          : null}
      </p>
    </section>
  );
}
