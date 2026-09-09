export interface PlanConfig {
  id: "free" | "pro" | "team";
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  description: string;
  features: string[];
  cta: string;
  ctaHref: string;
  highlighted: boolean;
}

export function planFamilyToPricingPlanId(
  planFamily: string | null | undefined,
): PlanConfig["id"] | null {
  switch (planFamily) {
    case "individual_free":
      return "free";
    case "individual_pro":
      return "pro";
    case "team_standard":
    case "team_premium":
      return "team";
    default:
      return null;
  }
}
