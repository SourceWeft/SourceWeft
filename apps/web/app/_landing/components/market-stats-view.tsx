import { useFormatter, useTranslations } from "next-intl";
import { LocaleLink } from "../../[locale]/_components/locale-link";
import type { LandingMarketStats } from "../../../lib/landing-market-stats";

export function MarketStatsView({
  stats,
  loading = false,
}: {
  stats?: LandingMarketStats;
  loading?: boolean;
}) {
  const t = useTranslations("landing.hero.stats");
  const format = useFormatter();
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-5" aria-busy={loading}>
      {(["mcp", "skills"] as const).map((key) => {
        const value = stats?.[key];
        return (
          <div key={key} className="flex min-w-24 flex-col">
            <dt className="order-2 mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              <LocaleLink
                href={`/${key}`}
                className="underline-offset-4 hover:underline"
              >
                {t(key)}
              </LocaleLink>
            </dt>
            <dd
              className={`${typeof value === "number" ? "text-xl font-bold" : "text-sm font-medium"} flex min-h-7 items-center text-zinc-900 dark:text-white`}
            >
              {loading
                ? t("loading")
                : typeof value === "number"
                  ? format.number(value)
                  : t("unavailable")}
            </dd>
          </div>
        );
      })}
      <div className="flex flex-col">
        <dt className="order-2 mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {t("selfHosted")}
        </dt>
        <dd className="flex min-h-7 items-center text-xl font-bold text-zinc-900 dark:text-white">
          {t("openSource")}
        </dd>
      </div>
    </dl>
  );
}
