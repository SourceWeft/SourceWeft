import { Check, Minus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { MarketMcpScore } from "@sourceweft/market-contracts";

/**
 * The completeness of a public MCP page (Issue #367, W6): the share of the
 * applicable listing checks met and every check with whether it is met and,
 * when it is not, one line on how the publisher raises it. The page shows no
 * letter grade (the API keeps one for existing readers); the score is the
 * market's, this only shows it.
 */

// Synchronous so the page's static render (and its tests) can draw it;
// `useTranslations` reads the request's messages in a server component too.
export function McpScoreCard({ score }: { score: MarketMcpScore }) {
  const t = useTranslations("mcp.score");
  // `applicable` is absent in answers cached before it existed: only an
  // explicit false means "does not apply".
  const applies = (item: MarketMcpScore["items"][number]) =>
    item.applicable !== false;
  return (
    <div
      className="rounded-xl border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]"
      data-score-percentage={score.percentage}
    >
      <div className="flex items-center gap-4">
        <p
          aria-hidden="true"
          className="shrink-0 text-4xl font-semibold tabular-nums"
        >
          {score.percentage}%
        </p>
        <div className="min-w-0">
          <p className="font-semibold">
            {t("percentage", { percentage: score.percentage })}
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
            data-score-applicable={applies(item)}
            data-score-item={item.key}
            data-score-met={item.met}
            key={item.key}
          >
            <div className="flex items-center gap-3 text-sm">
              {!applies(item) ? (
                <Minus
                  aria-label={t("notApplicable")}
                  className="size-4 shrink-0 text-zinc-400"
                  role="img"
                />
              ) : item.met ? (
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
                {applies(item)
                  ? t("weight", { weight: item.weight })
                  : t("notApplicable")}
              </span>
            </div>
            {!applies(item) ? (
              <p className="mt-1.5 pl-7 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {t(`items.${item.key}.notApplicableHint` as never)}
              </p>
            ) : !item.met ? (
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
