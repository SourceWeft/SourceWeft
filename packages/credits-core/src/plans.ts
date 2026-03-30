import type { PlanFamily } from "./types";

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
