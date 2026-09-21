"use client";

import * as React from "react";
import { useLocale } from "next-intl";
import {
  getSkillAiOverview,
  overviewLocale,
  type MarketSkillAiOverview,
} from "../../../../../lib/skill-overviews";
import type { DashboardSkillSlotProps } from "./slot-props";
import { SkillAiOverviewView } from "./skill-ai-overview-view";

/**
 * The AI overview at the top of the Overview tab (§17.4), in the viewer's
 * language (English when there is none in it). Read from the public market,
 * so a skill that is not public — or has no overview yet, or the request
 * fails — shows nothing at all.
 */
export function SkillAiOverview({ slug }: DashboardSkillSlotProps) {
  const locale = overviewLocale(useLocale());
  const [overview, setOverview] = React.useState<MarketSkillAiOverview | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    setOverview(null);
    getSkillAiOverview(slug, locale)
      .then((found) => {
        if (!cancelled) setOverview(found);
      })
      .catch(() => {
        // An optional extra: a failure is the same as having none.
      });
    return () => {
      cancelled = true;
    };
  }, [slug, locale]);

  if (!overview) return null;
  return <SkillAiOverviewView overview={overview} requestedLocale={locale} />;
}
