"use client";

import { toast } from "sonner";
import { useEffect, useMemo, useState } from "react";
import { TeamCheckoutDialog } from "../../_components/team-checkout-dialog";
import {
  trackBeginCheckout,
  trackCheckoutError,
} from "../../../lib/analytics-events";
import { authClient } from "../../../lib/auth-client";
import { billingClient } from "../../../lib/sdk";
import {
  planFamilyToPricingPlanId,
  type PlanConfig,
} from "../../_landing/pricing-config";
import type { LandingAuthState } from "../components/use-landing-auth-state";

type BillingInterval = "monthly" | "yearly";
type PaidPlanId = Extract<PlanConfig["id"], "pro" | "team">;
type BillingSummary = Awaited<ReturnType<typeof billingClient.getSummary>>;

type PricingOrg = {
  id: string;
  metadata?: unknown;
  name?: string;
  slug?: string;
};

function parseOrganizationMetadata(metadata: unknown) {
  if (!metadata) return {};
  if (typeof metadata === "object") {
    return metadata as { sourceweft?: { kind?: string } };
  }
  if (typeof metadata !== "string") return {};

  try {
    let parsed: unknown = JSON.parse(metadata);
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }

    return parsed && typeof parsed === "object"
      ? (parsed as { sourceweft?: { kind?: string } })
      : {};
  } catch {
    return {};
  }
}

function isPersonalOrganization(org: PricingOrg) {
  return (
    parseOrganizationMetadata(org.metadata).sourceweft?.kind === "personal"
  );
}

function formatPrice(cents: number): string {
  if (cents === 0) return "Free";
  return `$${(cents / 100).toFixed(0)}`;
}

function yearlyDiscount(monthly: number, yearly: number): number {
  if (monthly === 0) return 0;
  const monthlyAnnual = monthly * 12;
  return Math.round(((monthlyAnnual - yearly) / monthlyAnnual) * 100);
}

function isPaidPlan(planId: PlanConfig["id"]): planId is PaidPlanId {
  return planId === "pro" || planId === "team";
}

function createCheckoutIntent() {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return id;
}

function createReferenceKey(
  plan: PaidPlanId,
  interval: BillingInterval,
  seatCount?: number,
) {
  const seatSegment = seatCount ? `:${seatCount}` : "";
  return `pricing:${plan}:${interval}${seatSegment}:${createCheckoutIntent()}`;
}

function createPricingCheckoutPath(
  plan: PaidPlanId,
  interval: BillingInterval,
  source: "landing" | "dashboard" = "landing",
  teamOptions?: { seatCount?: number; teamName?: string },
) {
  const params = new URLSearchParams({
    plan,
    billingInterval: interval,
    source,
    intent: createCheckoutIntent(),
  });

  if (plan === "team") {
    const teamName = teamOptions?.teamName?.trim();
    if (teamName) {
      params.set("teamName", teamName);
    }

    if (teamOptions?.seatCount) {
      params.set("seatCount", String(teamOptions.seatCount));
    }
  }

  return `/dashboard/billing/checkout?${params.toString()}`;
}

function createPricingAuthHref(
  plan: PaidPlanId,
  interval: BillingInterval,
  teamOptions?: { seatCount?: number; teamName?: string },
) {
  return `/auth/sign-in?redirectTo=${encodeURIComponent(
    createPricingCheckoutPath(plan, interval, "landing", teamOptions),
  )}`;
}

function useSignedInBillingTeamId() {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { data: orgs } = authClient.useListOrganizations();

  return useMemo(() => {
    const activeOrgRecord = activeOrg as PricingOrg | null | undefined;
    if (activeOrgRecord?.id) {
      return activeOrgRecord.id;
    }

    return (
      ((orgs ?? []) as PricingOrg[]).find(isPersonalOrganization)?.id ?? null
    );
  }, [activeOrg, orgs]);
}

export function PricingToggle({
  authState,
  plans,
}: {
  authState: LandingAuthState;
  plans: PlanConfig[];
}) {
  if (authState.isSignedIn) {
    return <SignedInPricingToggle plans={plans} />;
  }

  return <PricingToggleInner billingTeamId={null} plans={plans} />;
}

function SignedInPricingToggle({ plans }: { plans: PlanConfig[] }) {
  const billingTeamId = useSignedInBillingTeamId();

  return <PricingToggleInner billingTeamId={billingTeamId} plans={plans} />;
}

function PricingToggleInner({
  billingTeamId,
  plans,
}: {
  billingTeamId: string | null;
  plans: PlanConfig[];
}) {
  const [yearly, setYearly] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState<"pro" | "team" | null>(null);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [teamCheckoutOpen, setTeamCheckoutOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      if (!billingTeamId) {
        setSummary(null);
        return;
      }

      try {
        const nextSummary = await billingClient.getSummary(billingTeamId);
        if (!cancelled) {
          setSummary(nextSummary);
        }
      } catch {
        if (!cancelled) {
          setSummary(null);
        }
      }
    }

    void loadSummary();

    return () => {
      cancelled = true;
    };
  }, [billingTeamId]);

  const currentPlanId = planFamilyToPricingPlanId(summary?.planFamily);
  const teamPlan = plans.find((plan) => plan.id === "team");
  const teamSeatPrice = teamPlan
    ? yearly
      ? teamPlan.yearlyPrice
      : teamPlan.monthlyPrice
    : 0;

  async function handleCheckout(planId: PlanConfig["id"]) {
    if (planId === "free") {
      const session = await authClient.getSession();
      const isLoggedIn = Boolean(session.data?.session || session.data?.user);
      window.location.assign(isLoggedIn ? "/dashboard" : "/auth/sign-in");
      return;
    }

    if (!isPaidPlan(planId)) {
      const session = await authClient.getSession();
      const isLoggedIn = Boolean(session.data?.session || session.data?.user);
      window.location.assign(isLoggedIn ? "/dashboard" : "/auth/sign-in");
      return;
    }

    const billingInterval = yearly ? "yearly" : "monthly";

    if (planId === "team") {
      setTeamCheckoutOpen(true);
      return;
    }

    const session = await authClient.getSession();
    const isLoggedIn = Boolean(session.data?.session || session.data?.user);

    if (!isLoggedIn) {
      window.location.assign(createPricingAuthHref(planId, billingInterval));
      return;
    }

    setLoadingPlan(planId);
    try {
      const result = await billingClient.createPricingCheckout({
        plan: planId,
        billingInterval,
        source: "landing",
        clientReferenceKey: createReferenceKey(planId, billingInterval),
      });
      trackBeginCheckout({
        billingInterval,
        plan: planId,
        source: "landing",
      });
      window.location.assign(result.checkoutUrl);
    } catch (error) {
      trackCheckoutError({
        billingInterval,
        plan: planId,
        source: "landing",
      });
      toast.error(
        error instanceof Error ? error.message : "Unable to start checkout.",
      );
    } finally {
      setLoadingPlan(null);
    }
  }

  return (
    <div>
      <div className="mb-10 flex justify-center">
        <div
          aria-label="Billing period"
          className="inline-flex rounded-xl border border-zinc-200 bg-zinc-100 p-1 dark:border-white/12 dark:bg-white/5"
          role="group"
        >
          {(["monthly", "yearly"] as const).map((period) => {
            const active = yearly === (period === "yearly");

            return (
              <button
                aria-label={period === "monthly" ? "Monthly" : "Yearly"}
                aria-pressed={active}
                className={`inline-flex min-w-24 items-center justify-center rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-white/40 ${
                  active
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-white dark:text-zinc-950"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
                }`}
                key={period}
                onClick={() => setYearly(period === "yearly")}
                type="button"
              >
                {period === "monthly" ? (
                  "Monthly"
                ) : (
                  <>
                    Yearly
                    <span className="ml-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400">
                      2 months free
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const price = yearly ? plan.yearlyPrice : plan.monthlyPrice;
          const discount =
            yearly && plan.monthlyPrice > 0
              ? yearlyDiscount(plan.monthlyPrice, plan.yearlyPrice)
              : 0;
          const isCurrent = currentPlanId === plan.id;
          const ctaLabel =
            loadingPlan === plan.id
              ? "Opening..."
              : isCurrent
                ? "Current plan"
                : plan.id === "team"
                  ? "Create team"
                  : plan.id === "pro"
                    ? "Upgrade to Pro"
                    : plan.cta;
          const ctaClassName = `block w-full rounded-lg px-4 py-2.5 text-center text-sm font-medium transition-colors ${
            plan.highlighted
              ? "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
              : "border border-zinc-200 text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5"
          }`;

          return (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-2xl border p-6 transition-all duration-200 ${
                plan.highlighted
                  ? "border-zinc-300 bg-white shadow-lg dark:border-white/30 dark:bg-zinc-800/80 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_8px_32px_rgba(0,0,0,0.4)]"
                  : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 hover:bg-white hover:shadow-sm dark:border-white/8 dark:bg-zinc-900/60 dark:hover:border-white/16 dark:hover:bg-zinc-900/60"
              }`}
            >
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full border border-zinc-200 bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:border-white/20 dark:bg-zinc-700 dark:text-white">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="mb-4">
                <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  {plan.name}
                </p>
                <div className="mt-2 flex items-end gap-1">
                  <span className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-white">
                    {formatPrice(price)}
                  </span>
                  {price > 0 && (
                    <span className="mb-1 text-sm text-zinc-400 dark:text-zinc-500">
                      /{yearly ? "yr" : "mo"}
                      {plan.id === "team" ? " / seat" : ""}
                    </span>
                  )}
                </div>
                <p
                  className={`mt-1 text-xs text-emerald-600 dark:text-emerald-400 ${discount > 0 ? "visible" : "invisible"}`}
                >
                  2 months free vs monthly
                </p>
                <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-500">
                  {plan.description}
                </p>
              </div>

              <ul className="mb-6 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-300"
                  >
                    <svg
                      className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-400"
                      fill="none"
                      viewBox="0 0 16 16"
                    >
                      <path
                        d="M3 8l3.5 3.5L13 4.5"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                className={`${ctaClassName} disabled:pointer-events-none disabled:opacity-60`}
                disabled={loadingPlan === plan.id || isCurrent}
                onClick={() => void handleCheckout(plan.id)}
                type="button"
              >
                {ctaLabel}
              </button>
            </div>
          );
        })}
      </div>

      <TeamCheckoutDialog
        authRedirectOnUnauthenticated
        billingInterval={yearly ? "yearly" : "monthly"}
        onOpenChange={setTeamCheckoutOpen}
        open={teamCheckoutOpen}
        perSeatPrice={teamSeatPrice}
        referencePrefix="pricing"
        source="landing"
      />
    </div>
  );
}
