"use client";
import { useBillingControls, useBillingUiHost } from "./context";

import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";

import type { BillingInterval } from "./types";
import { useBillingPlanAction } from "./use-billing-plan-action";

export function BillingPlanActionControls({
  action,
  billingPeriod,
  onBillingPeriodChange,
  showBillingPeriod = true,
}: {
  action: ReturnType<typeof useBillingPlanAction>;
  billingPeriod: BillingInterval;
  onBillingPeriodChange: (value: BillingInterval) => void;
  showBillingPeriod?: boolean;
}) {
  const labels = useBillingControls();
  const { billingCheckoutEnabled } = useBillingUiHost();

  if (!billingCheckoutEnabled) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showBillingPeriod && !action.shouldManageBilling ? (
        <div
          aria-label={labels.billingPeriod}
          className="flex rounded-lg border border-border bg-muted/40 p-0.5"
          role="group"
        >
          {(["monthly", "yearly"] as const).map((period) => (
            <button
              aria-pressed={billingPeriod === period}
              className={cn(
                "min-w-16 rounded-md px-2.5 py-1 text-xs transition-colors",
                billingPeriod === period
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={period}
              onClick={() => onBillingPeriodChange(period)}
              type="button"
            >
              {labels[period]}
            </button>
          ))}
        </div>
      ) : null}
      <Button
        disabled={action.actionDisabled}
        onClick={() => void action.handleAction()}
        size="sm"
        type="button"
        variant="outline"
      >
        {action.actionLoading ? labels.opening : action.actionLabel}
      </Button>
    </div>
  );
}
