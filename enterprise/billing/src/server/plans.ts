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
    monthlyCreditsGrant: 20000,
  },
  team_standard: {
    active: true,
    monthlyPagesLimit: 20000,
    monthlyCreditsGrant: 36000,
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
    const pro = planQuotaByFamily["individual_pro"];
    const n = Math.max(2, Math.floor(seatCount));
    return {
      active: true,
      monthlyPagesLimit: pro.monthlyPagesLimit * n,
      monthlyCreditsGrant: pro.monthlyCreditsGrant * n,
    };
  }
  return planQuotaByFamily[planFamily];
}

/**
 * The allocation a single member receives, independent of how many seats the
 * team has. Credits and pages are granted per-member (each `billing_accounts`
 * row is keyed on `(team_id, user_id)`), so a team member's own quota is one
 * seat's worth — a `team_standard` seat is an `individual_pro` allocation.
 * `getPlanQuota` (seat-scaled team total) stays for catalog/pricing display.
 */
export function getPerSeatQuota(planFamily: PlanFamily): PlanQuota {
  if (planFamily === "team_standard") {
    return planQuotaByFamily["individual_pro"];
  }
  return planQuotaByFamily[planFamily];
}
