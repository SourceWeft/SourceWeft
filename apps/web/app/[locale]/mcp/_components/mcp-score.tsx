import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type {
  MarketMcpScore,
  MarketMcpScoreGrade,
} from "@sourceweft/market-contracts";

/**
 * The quality scorecard of a public MCP page (Issue #367, W6): the grade,
 * the share of the listing checks met, and every check with whether it is
 * met and, when it is not, one line on how the publisher raises it. The
 * score is the market's; this only shows it.
 */

const GRADE_CLASS_NAMES: Record<MarketMcpScoreGrade, string> = {
  A: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-200",
  B: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-200",
  F: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-300/20 dark:bg-rose-300/10 dark:text-rose-200",
};

// Synchronous so the page's static render (and its tests) can draw it;
// `useTranslations` reads the request's messages in a server component too.
export function McpScoreCard({ score }: { score: MarketMcpScore }) {
  const t = useTranslations("mcp.score");
  return (
    <div
      className="rounded-xl border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]"
      data-score-grade={score.grade}
      data-score-percentage={score.percentage}
    >
      <div className="flex items-start gap-4">
        <div
          aria-label={t("gradeLabel", { grade: score.grade })}
          className={`flex size-14 shrink-0 items-center justify-center rounded-xl border text-2xl font-semibold tabular-nums ${GRADE_CLASS_NAMES[score.grade]}`}
          role="img"
        >
          {score.grade}
        </div>
        <div className="min-w-0">
          <p className="font-semibold">
            {t("percentage", { percentage: score.percentage })}
          </p>
          <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            {t(`gradeExplain.${score.grade}`)}
          </p>
          <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {t("intro")}
          </p>
        </div>
      </div>
      <ul className="mt-5 divide-y divide-zinc-200 border-t border-zinc-200 dark:divide-white/10 dark:border-white/10">
        {score.items.map((item) => (
          <li
            className="py-3"
            data-score-item={item.key}
            data-score-met={item.met}
            key={item.key}
          >
            <div className="flex items-center gap-3 text-sm">
              {item.met ? (
                <Check
                  aria-label={t("met")}
                  className="size-4 shrink-0 text-emerald-600 dark:text-emerald-300"
                  role="img"
                />
              ) : (
                <X
                  aria-label={t("notMet")}
                  className="size-4 shrink-0 text-zinc-400"
                  role="img"
                />
              )}
              <span className="font-medium">
                {t(`items.${item.key}.label`)}
              </span>
              {item.required ? (
                <span className="inline-flex h-5 items-center rounded-full border border-zinc-300 px-2 text-[11px] font-medium text-zinc-600 dark:border-white/10 dark:text-zinc-300">
                  {t("required")}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 tabular-nums text-zinc-500">
                {t("weight", { weight: item.weight })}
              </span>
            </div>
            {!item.met ? (
              <p className="mt-1.5 pl-7 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {t(`items.${item.key}.hint`)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
