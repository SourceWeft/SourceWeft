import type { Locale } from "@sourceweft/i18n/locales";
import type { AvailablePublicSkillRunStats } from "../../../../../lib/public-skill-run-stats";
import { publicRunStatsCopy } from "./public-run-stats-copy";

/**
 * The public page's run-stats panel: pure, rendered from data the server
 * component already fetched. A copy of the dashboard's summary rather than an
 * import of it, so the public tree does not follow the dashboard's own
 * localization, and it is styled like the rest of the public aside.
 */

/**
 * A success rate as a whole percent that never rounds up to 100% while a run
 * failed, nor down to 0% while one succeeded.
 */
export function formatPublicSuccessRate(rate: number, locale: Locale) {
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

/** "Ran 124 times … · 92% succeeded · Common issue: missing pptxgenjs". */
export function publicRunStatsSentence(
  stats: AvailablePublicSkillRunStats,
  locale: Locale,
) {
  const copy = publicRunStatsCopy(locale);
  const top = stats.topErrors[0];
  return [
    copy.ran(
      new Intl.NumberFormat(locale).format(stats.runs),
      stats.runs,
      stats.windowDays,
    ),
    copy.succeeded(formatPublicSuccessRate(stats.successRate, locale)),
    ...(top
      ? [copy.commonIssue(copy.errorLabel(top.errorClass, top.subject))]
      : []),
  ].join(copy.separator);
}

// The public page's aside panel style.
const panelClassName =
  "rounded-xl border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]";

export function PublicSkillRunStatsPanel({
  stats,
  locale,
}: {
  stats: AvailablePublicSkillRunStats;
  locale: Locale;
}) {
  const copy = publicRunStatsCopy(locale);
  return (
    <section aria-label={copy.heading} className={panelClassName}>
      <h2 className="mb-2 text-base font-semibold">{copy.heading}</h2>
      <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {publicRunStatsSentence(stats, locale)}
      </p>
    </section>
  );
}
