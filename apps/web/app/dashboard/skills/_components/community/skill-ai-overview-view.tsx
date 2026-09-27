"use client";

import { CatalogAiOverview } from "@/app/_components/market/catalog-ai-overview";
import type { MarketSkillAiOverview } from "../../../../../lib/skill-overviews";
import { useTranslations } from "next-intl";

/**
 * A skill's AI overview, in the shared catalog overview block with the
 * skill's own wording. It only renders what it is given; the labels are UI
 * chrome, the overview text is shown as written, as plain text.
 */
export function SkillAiOverviewView({
  overview,
  requestedLocale,
}: {
  overview: MarketSkillAiOverview;
  // The language asked for; a note shows when the overview fell back.
  requestedLocale?: string;
}) {
  const t = useTranslations("dashboardSkillOverview.block");
  const fellBack =
    requestedLocale !== undefined && requestedLocale !== overview.locale;

  return (
    <CatalogAiOverview
      data-testid="skill-ai-overview"
      overview={overview}
      labels={{
        title: t("title"),
        whatItDoes: t("whatItDoes"),
        whenToUse: t("whenToUse"),
        requirements: t("requirements"),
      }}
      explainer={{ label: t("explainerLabel"), text: t("explainer") }}
      notice={fellBack ? t("englishFallback") : null}
    />
  );
}
