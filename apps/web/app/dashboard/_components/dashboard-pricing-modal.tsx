"use client";

import * as React from "react";
import { Check, Sparkles } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { toast } from "sonner";
import { billingClient } from "../../../lib/sdk";
import type { PlanConfig } from "../../_landing/pricing-config";
import { DashboardModalShell, DashboardSection } from "./dashboard-modal-shell";

type BillingSummary = Awaited<ReturnType<typeof billingClient.getSummary>>;

function createReferenceKey(plan: "pro" | "team", interval: "monthly" | "yearly") {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `dashboard-pricing:${plan}:${interval}:${id}`;
}

function formatPrice(cents: number) {
  if (cents === 0) return "Free";
  return `$${(cents / 100).toFixed(0)}`;
}

export function DashboardPricingModal({
  open,
  onOpenChange,
  plans,
  billingPeriod,
  onBillingPeriodChange,
  summary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: PlanConfig[];
  billingPeriod: "monthly" | "yearly";
  onBillingPeriodChange: (value: "monthly" | "yearly") => void;
  summary?: BillingSummary | null;
}) {
  const [loadingPlan, setLoadingPlan] = React.useState<"pro" | "team" | null>(
    null,
  );
  const currentPlan = summary?.planFamily ?? "individual_free";

  async function handlePlanAction(planId: PlanConfig["id"]) {
    if (planId === "free") {
      return;
    }

    setLoadingPlan(planId);
    try {
      const result = await billingClient.createPricingCheckout({
        plan: planId,
        billingInterval: billingPeriod,
        source: "dashboard",
        clientReferenceKey: createReferenceKey(planId, billingPeriod),
      });
      window.location.assign(result.checkoutUrl);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to start checkout.",
      );
    } finally {
      setLoadingPlan(null);
    }
  }

  return (
    <DashboardModalShell
      actions={
        <div
          aria-label="Billing period"
          className="inline-flex rounded-xl border border-border bg-muted/60 p-1"
          role="group"
        >
          {(["monthly", "yearly"] as const).map((period) => (
            <button
              aria-pressed={billingPeriod === period}
              className={`min-w-20 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                billingPeriod === period
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              key={period}
              onClick={() => onBillingPeriodChange(period)}
              type="button"
            >
              {period === "monthly" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      }
      className="sm:max-w-5xl"
      contentClassName="bg-muted/5"
      description="Compare plans for personal use and team collaboration."
      fullScreen={true}
      onOpenChange={onOpenChange}
      open={open}
      title="Pricing"
    >
      <div className="space-y-3">
        <div className="grid gap-3 xl:grid-cols-3">
          {plans.map((plan) => {
            const price = billingPeriod === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
            const modeLabel = plan.id === "free" ? "Explore" : plan.id === "team" ? "Collaborate" : "Scale";
            const isCurrent =
              (plan.id === "free" && currentPlan === "individual_free") ||
              (plan.id === "pro" && currentPlan === "individual_pro");
            const buttonLabel = isCurrent
              ? "Current plan"
              : loadingPlan === plan.id
                ? "Opening..."
                : plan.id === "team"
                  ? "Create team"
                  : "Upgrade";
            return (
              <DashboardSection
                className={plan.highlighted ? "border-primary/30 bg-card shadow-[0_12px_32px_rgba(0,0,0,0.06)]" : "bg-background/90"}
                eyebrow={isCurrent ? "Current" : plan.highlighted ? "Recommended" : "Plan"}
                key={plan.id}
                title={plan.name}
              >
                <div className="flex min-h-full flex-col">
                  <div className="inline-flex w-fit items-center rounded-full border border-input bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                    {modeLabel}
                  </div>
                  <div className="mt-4 flex items-end gap-1.5">
                    <span className="text-3xl font-semibold tracking-tight text-foreground">
                      {formatPrice(price)}
                    </span>
                    {price > 0 ? (
                      <span className="mb-1 text-sm text-muted-foreground">
                        /{billingPeriod === "yearly" ? "yr" : "mo"}
                        {plan.id === "team" ? " / seat" : ""}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{plan.description}</p>
                  <div className="mt-5 flex-1 space-y-2.5">
                    {plan.features.map((feature) => (
                      <div className="flex items-start gap-2 text-sm text-foreground" key={feature}>
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span>{feature}</span>
                      </div>
                    ))}
                  </div>
                  {plan.id === "team" ? (
                    <p className="mt-4 text-xs leading-5 text-muted-foreground">
                      Checkout creates a new team after payment. Extra seats stay in dashboard billing.
                    </p>
                  ) : null}
                  <Button
                    className="mt-5 w-full"
                    disabled={isCurrent || loadingPlan === plan.id}
                    onClick={() => void handlePlanAction(plan.id)}
                    size="sm"
                    type="button"
                    variant={plan.highlighted ? "default" : "outline"}
                  >
                    {buttonLabel}
                  </Button>
                </div>
              </DashboardSection>
            );
          })}
        </div>

        <DashboardSection
          eyebrow="Plan Notes"
          meta="A quieter, in-product comparison surface instead of a landing-style pricing page"
          title="How plans map to your workspace shell"
        >
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              Personal plans focus on individual chat, sources, and account-level billing.
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              Team plans add shared workspaces, member access, and organization-level billing controls.
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              Team checkout creates a new paid team after provider confirmation.
            </div>
          </div>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            Pricing data stays shared with the landing page configuration.
          </div>
        </DashboardSection>
      </div>
    </DashboardModalShell>
  );
}
