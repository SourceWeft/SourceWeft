import { useFormatter, useTranslations } from "next-intl";
import type { SkillReviewSummary as Summary } from "../../../../../lib/skill-reviews";
import {
  formatReviewAverage,
  reviewDistributionPercent,
  SKILL_REVIEW_STARS,
} from "./skill-review-format";
import { SkillReviewStars } from "./skill-review-stars";

/**
 * The average, its stars, the count and one bar per star. Presentational:
 * it renders from `summary` alone.
 */
export function SkillReviewSummary({
  summary,
}: {
  summary: Summary;
}) {
  const t = useTranslations("dashboardSkillReviews");
  const format = useFormatter();
  const average = formatReviewAverage(summary.average);
  return (
    <div
      data-testid="skill-review-summary"
      className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-8"
    >
      <div className="flex shrink-0 flex-col items-start gap-1">
        <span
          className="text-4xl font-semibold tabular-nums text-foreground"
          aria-label={t("averageLabel", { average })}
        >
          {average}
        </span>
        <SkillReviewStars rating={summary.average ?? 0} size="md" />
        <span className="text-xs text-muted-foreground">
          {t("reviewCount", { count: summary.count })}
        </span>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {SKILL_REVIEW_STARS.map((stars) => {
          const count = summary.distribution[stars];
          return (
            <li
              key={stars}
              aria-label={t("distributionLabel", { stars, count })}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <span className="w-3 text-right tabular-nums">{stars}</span>
              <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  data-testid={`skill-review-bar-${stars}`}
                  className="absolute inset-y-0 left-0 rounded-full bg-amber-400"
                  style={{
                    width: `${reviewDistributionPercent(summary, stars)}%`,
                  }}
                />
              </span>
              <span className="w-8 text-right tabular-nums">
                {format.number(count)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
