"use client";

import { Check, Sparkles } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@sourceweft/ui-web/components/ui/tabs";
import type { PlanConfig } from "../../_landing/pricing-config";
import { DashboardModalShell, DashboardSection } from "./dashboard-modal-shell";

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: PlanConfig[];
  billingPeriod: "monthly" | "yearly";
  onBillingPeriodChange: (value: "monthly" | "yearly") => void;
}) {
  return (
    <DashboardModalShell
      actions={
        <Tabs onValueChange={(value) => onBillingPeriodChange(value as "monthly" | "yearly")} value={billingPeriod}>
          <TabsList className="rounded-xl bg-muted/60 p-1">
            <TabsTrigger className="min-w-20 text-xs" value="monthly">
              Monthly
            </TabsTrigger>
            <TabsTrigger className="min-w-20 text-xs" value="yearly">
              Yearly
            </TabsTrigger>
          </TabsList>
        </Tabs>
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
            return (
              <DashboardSection
                className={plan.highlighted ? "border-primary/30 bg-card shadow-[0_12px_32px_rgba(0,0,0,0.06)]" : "bg-background/90"}
                eyebrow={plan.highlighted ? "Recommended" : "Plan"}
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
                  <Button className="mt-5 w-full" size="sm" type="button" variant={plan.highlighted ? "default" : "outline"}>
                    {plan.cta}
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
              Upgrade and checkout actions are mocked in this dashboard preview.
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
