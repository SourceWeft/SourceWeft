export interface PlanConfig {
  id: "free" | "pro" | "team";
  name: string;
  monthlyPrice: number; // USD cents, 0 = free
  yearlyPrice: number; // USD cents
  description: string;
  features: string[];
  cta: string;
  ctaHref: string;
  highlighted: boolean;
  creemProductMonthly?: string;
  creemProductYearly?: string;
}

function cents(envVar: string | undefined, fallback: number): number {
  const n = parseInt(envVar ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getPricingConfig(): PlanConfig[] {
  return [
    {
      id: "free",
      name: "Free",
      monthlyPrice: 0,
      yearlyPrice: 0,
      description: "For individuals exploring VelaMind",
      features: [
        "300 pages / month",
        "3,000 credits / month",
        "All features included",
        "Browser extension",
        "Community support",
      ],
      cta: "Get Started",
      ctaHref: "/auth/sign-up",
      highlighted: false,
    },
    {
      id: "pro",
      name: "Pro",
      monthlyPrice: cents(process.env.NEXT_PUBLIC_PRICING_PRO_MONTHLY, 2000),
      yearlyPrice: cents(process.env.NEXT_PUBLIC_PRICING_PRO_YEARLY, 20000),
      description: "For power users who need more capacity",
      features: [
        "6,000 pages / month",
        "20,000 credits / month",
        "All features included",
        "Browser extension + desktop app",
        "Priority support",
      ],
      cta: "Start Free Trial",
      ctaHref: "/auth/sign-up",
      highlighted: true,
      creemProductMonthly: process.env.NEXT_PUBLIC_CREEM_PRODUCT_PRO_MONTHLY,
      creemProductYearly: process.env.NEXT_PUBLIC_CREEM_PRODUCT_PRO_YEARLY,
    },
    {
      id: "team",
      name: "Team",
      monthlyPrice: cents(process.env.NEXT_PUBLIC_PRICING_TEAM_MONTHLY, 2000),
      yearlyPrice: cents(process.env.NEXT_PUBLIC_PRICING_TEAM_YEARLY, 20000),
      description: "For teams building shared knowledge",
      features: [
        "6,000 pages × seats / month",
        "20,000 credits × seats / month",
        "Shared workspaces & RBAC",
        "Team analytics",
        "SSO (coming soon)",
        "Dedicated support",
      ],
      cta: "Start Team Trial",
      ctaHref: "/auth/sign-up",
      highlighted: false,
      creemProductMonthly: process.env.NEXT_PUBLIC_CREEM_PRODUCT_TEAM_MONTHLY,
      creemProductYearly: process.env.NEXT_PUBLIC_CREEM_PRODUCT_TEAM_YEARLY,
    },
  ];
}
