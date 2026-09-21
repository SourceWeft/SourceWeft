"use client";

import * as React from "react";
import {
  loadSkillRunStatsView,
  type SkillRunStatsView,
} from "../../../../../lib/skill-run-stats";
import type { DashboardSkillSlotProps } from "./slot-props";
import {
  SkillRunStatsDetails,
  SkillRunStatsSummary,
} from "./skill-run-stats-view";

/**
 * Sandbox run stats in the side column (§17.5). The skill's verified author
 * and market admins see every number, marked private; everyone else sees the
 * public line once the skill clears its floor of runs and workspaces, and
 * nothing before that. A failed request also renders nothing: the stats are
 * an extra, never an error on the page.
 */
export function SkillRunStats({ slug }: DashboardSkillSlotProps) {
  const [view, setView] = React.useState<SkillRunStatsView>({ kind: "none" });

  React.useEffect(() => {
    let current = true;
    setView({ kind: "none" });
    loadSkillRunStatsView(slug).then(
      (next) => {
        if (current) setView(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [slug]);

  if (view.kind === "full") return <SkillRunStatsDetails stats={view.stats} />;
  if (view.kind === "public")
    return <SkillRunStatsSummary stats={view.stats} />;
  return null;
}
