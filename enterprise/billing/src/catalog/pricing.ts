import type { BillingDisplayCatalog } from "@sourceweft/contracts/billing-catalog";

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

/** The localized card copy for each plan; feature lines may use `{pages}` and `{credits}`. */
export type PlansCopy = Record<
  PlanConfig["id"],
  {
    name: string;
    description: string;
    cta: string;
    features: readonly string[];
  }
>;

/**
 * Pricing cards: prices, ids and structure from the catalog the deployment
 * publishes; wording from `copy`. Quota numbers in the feature lines are filled
 * from the catalog (en-US grouping in every locale, e.g. "8,000"), so a changed
 * quota never leaves a stale number behind.
 */
export function buildPricingPlans(
  catalog: BillingDisplayCatalog,
  copy: PlansCopy,
): PlanConfig[] {
  const number = new Intl.NumberFormat("en-US");
  const card = (
    id: PlanConfig["id"],
    plan: { credits: number; pages: number },
    prices: { monthly: number; yearly: number },
    extra: Pick<PlanConfig, "ctaHref" | "highlighted">,
  ): PlanConfig => ({
    id,
    name: copy[id].name,
    monthlyPrice: prices.monthly,
    yearlyPrice: prices.yearly,
    description: copy[id].description,
    features: copy[id].features.map((line) =>
      line
        .replaceAll("{pages}", number.format(plan.pages))
        .replaceAll("{credits}", number.format(plan.credits)),
    ),
    cta: copy[id].cta,
    ...extra,
  });
  const signIn = "/auth/sign-in";
  const { free, pro, team } = catalog.plans;
  return [
    card(
      "free",
      free,
      { monthly: 0, yearly: 0 },
      { ctaHref: signIn, highlighted: false },
    ),
    card("pro", pro, pro.priceCents, { ctaHref: signIn, highlighted: true }),
    card("team", team, team.priceCents, {
      ctaHref: signIn,
      highlighted: false,
    }),
  ];
}
