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

export type PricingEnv = Partial<
  Record<
    | "NEXT_PUBLIC_PRICING_PRO_MONTHLY"
    | "NEXT_PUBLIC_PRICING_PRO_YEARLY"
    | "NEXT_PUBLIC_PRICING_TEAM_MONTHLY"
    | "NEXT_PUBLIC_PRICING_TEAM_YEARLY",
    string | undefined
  >
>;

function readProcessEnv(): PricingEnv {
  const maybeProcess = (globalThis as { process?: { env?: PricingEnv } })
    .process;
  return maybeProcess?.env ?? {};
}

function cents(envVar: string | undefined, fallback: number): number {
  const n = parseInt(envVar ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getPricingConfig(
  env: PricingEnv = readProcessEnv(),
): PlanConfig[] {
  return [
    {
      id: "free",
      name: "Free",
      monthlyPrice: 0,
      yearlyPrice: 0,
      description: "For individuals exploring SourceWeft",
      features: [
        "300 pages / month",
        "3,000 credits / month",
        "All features included",
        "Browser extension + desktop app",
        "Community support",
      ],
      cta: "Get Started",
      ctaHref: "/auth/sign-in",
      highlighted: false,
    },
    {
      id: "pro",
      name: "Pro",
      monthlyPrice: cents(env.NEXT_PUBLIC_PRICING_PRO_MONTHLY, 2000),
      yearlyPrice: cents(env.NEXT_PUBLIC_PRICING_PRO_YEARLY, 20000),
      description: "For power users who need more capacity",
      features: [
        "6,000 pages / month",
        "20,000 credits / month",
        "All features included",
        "Browser extension + desktop app",
        "Agent observability",
        "Priority support",
      ],
      cta: "Upgrade to Pro",
      ctaHref: "/auth/sign-in",
      highlighted: true,
    },
    {
      id: "team",
      name: "Team",
      monthlyPrice: cents(env.NEXT_PUBLIC_PRICING_TEAM_MONTHLY, 2000),
      yearlyPrice: cents(env.NEXT_PUBLIC_PRICING_TEAM_YEARLY, 20000),
      description: "For teams building shared knowledge",
      features: [
        "6,000 pages × seats / month",
        "20,000 credits × seats / month",
        "Agent observability",
        "Shared workspaces & RBAC",
        "Team analytics",
        "SSO (coming soon)",
        "Dedicated support",
      ],
      cta: "Create team",
      ctaHref: "/auth/sign-in",
      highlighted: false,
    },
  ];
}
