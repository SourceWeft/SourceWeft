import type { PlanFamily } from "@sourceweft/contracts";

export type PlanQuota = {
  active: boolean;
  monthlyPagesLimit: number;
  monthlyCreditsGrant: number;
};

export const planQuotaByFamily: Record<PlanFamily, PlanQuota> = {
  individual_free: {
    active: true,
    monthlyPagesLimit: 300,
    monthlyCreditsGrant: 3000,
  },
  individual_pro: {
    active: true,
    monthlyPagesLimit: 6000,
    monthlyCreditsGrant: 8000,
  },
  // Per seat; `getPlanQuota` scales it by the team's seat count.
  team_standard: {
    active: true,
    monthlyPagesLimit: 6000,
    monthlyCreditsGrant: 8000,
  },
  team_premium: {
    active: false,
    monthlyPagesLimit: 100000,
    monthlyCreditsGrant: 150000,
  },
  enterprise_usage: {
    active: false,
    monthlyPagesLimit: 0,
    monthlyCreditsGrant: 0,
  },
};

export function getPlanQuota(planFamily: PlanFamily, seatCount = 1): PlanQuota {
  if (planFamily === "team_standard") {
    const seat = planQuotaByFamily["team_standard"];
    const n = Math.max(2, Math.floor(seatCount));
    return {
      active: true,
      monthlyPagesLimit: seat.monthlyPagesLimit * n,
      monthlyCreditsGrant: seat.monthlyCreditsGrant * n,
    };
  }
  return planQuotaByFamily[planFamily];
}

/**
 * The allocation a single member receives, independent of how many seats the
 * team has. Credits and pages are granted per-member (each `billing_accounts`
 * row is keyed on `(team_id, user_id)`), so a team member's own quota is one
 * seat's worth.
 * `getPlanQuota` (seat-scaled team total) stays for catalog/pricing display.
 */
export function getPerSeatQuota(planFamily: PlanFamily): PlanQuota {
  return planQuotaByFamily[planFamily];
}
