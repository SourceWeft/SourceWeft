import type { PlanFamily } from "@sourceweft/contracts";
import type { ScheduledTaskLimits } from "@sourceweft/contracts/billing-runtime";
import type { BillingRuntimeConfig } from "./types";

export type PlanQuota = {
  active: boolean;
  monthlyPagesLimit: number;
  monthlyCreditsGrant: number;
};

type QuotaSource = Pick<BillingRuntimeConfig, "planQuotas">;

// Plans that are not sold yet carry no catalog entry.
const TEAM_PREMIUM_QUOTA: PlanQuota = {
  active: false,
  monthlyPagesLimit: 100000,
  monthlyCreditsGrant: 150000,
};
const ENTERPRISE_USAGE_QUOTA: PlanQuota = {
  active: false,
  monthlyPagesLimit: 0,
  monthlyCreditsGrant: 0,
};

/**
 * The allocation a single member receives, independent of how many seats the
 * team has. Credits and pages are granted per-member (each `billing_accounts`
 * row is keyed on `(team_id, user_id)`), so a team member's own quota is one
 * seat's worth. `getPlanQuota` (seat-scaled team total) stays for
 * catalog/pricing display.
 */
export function getPerSeatQuota(
  config: QuotaSource,
  planFamily: PlanFamily,
): PlanQuota {
  switch (planFamily) {
    case "individual_free":
    case "individual_pro":
    case "team_standard":
      return config.planQuotas[planFamily];
    case "team_premium":
      return TEAM_PREMIUM_QUOTA;
    case "enterprise_usage":
      return ENTERPRISE_USAGE_QUOTA;
  }
}

/**
 * Scheduled tasks one member may have enabled at once, by plan. Per member,
 * like credits: a team seat gets the full number, not a share of a pool.
 * The tiers above the team plan are not sold yet and share the top number.
 */
const SCHEDULED_TASK_LIMITS: Record<PlanFamily, ScheduledTaskLimits> = {
  individual_free: { maxActiveTasks: 3 },
  individual_pro: { maxActiveTasks: 10 },
  team_standard: { maxActiveTasks: 15 },
  team_premium: { maxActiveTasks: 25 },
  enterprise_usage: { maxActiveTasks: 25 },
};

export function getScheduledTaskLimits(
  planFamily: PlanFamily,
): ScheduledTaskLimits {
  return { ...SCHEDULED_TASK_LIMITS[planFamily] };
}

export function getPlanQuota(
  config: QuotaSource,
  planFamily: PlanFamily,
  seatCount = 1,
): PlanQuota {
  if (planFamily === "team_standard") {
    const seat = config.planQuotas.team_standard;
    const n = Math.max(2, Math.floor(seatCount));
    return {
      active: true,
      monthlyPagesLimit: seat.monthlyPagesLimit * n,
      monthlyCreditsGrant: seat.monthlyCreditsGrant * n,
    };
  }
  return getPerSeatQuota(config, planFamily);
}
