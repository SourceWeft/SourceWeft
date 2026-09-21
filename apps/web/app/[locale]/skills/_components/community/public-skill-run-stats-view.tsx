import { useLocale, useTranslations } from "next-intl";
import type { AvailablePublicSkillRunStats } from "../../../../../lib/public-skill-run-stats";
import { skillRunStatsSentence } from "../../../../dashboard/skills/_components/community/skill-run-stats-view";

/**
 * The public page's run-stats panel: pure, rendered from data the server
 * component already fetched. The sentence is the dashboard's (same words,
 * same `dashboardSkillRunStats` messages); only the panel is the public
 * aside's own style.
 */

// The public page's aside panel style.
const panelClassName =
  "rounded-xl border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]";

export function PublicSkillRunStatsPanel({
  stats,
}: {
  stats: AvailablePublicSkillRunStats;
}) {
  const t = useTranslations("dashboardSkillRunStats");
  const locale = useLocale();
  return (
    <section aria-label={t("heading")} className={panelClassName}>
      <h2 className="mb-2 text-base font-semibold">{t("heading")}</h2>
      <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {skillRunStatsSentence(stats, t, locale)}
      </p>
    </section>
  );
}
