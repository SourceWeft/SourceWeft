"use client";
import { useBillingControls, useBillingUiHost } from "./context";
import { useBillingCopy } from "./use-billing-copy";

import * as React from "react";
import { toast } from "sonner";

import type {
  BillingInterval,
  BillingSubscription,
  BillingSummary,
} from "./types";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  createBillingReferenceKey,
  isNonFreePlanFamily,
  openBillingPortalWindow,
} from "./billing-utils";

export function useBillingPlanAction(input: {
  billingPeriod: BillingInterval;
  isPersonal: boolean;
  summary: BillingSummary | null;
  subscription: BillingSubscription | null;
  teamId: string | null;
  teamSeatCount?: number;
}) {
  const {
    billingCheckoutEnabled,
    trackBeginCheckout,
    trackBillingPortalOpened,
    trackCheckoutError,
    billingClient,
    openCheckout,
  } = useBillingUiHost();
  const { copy } = useBillingCopy();
  const controls = useBillingControls();

  const [actionLoading, setActionLoading] = React.useState(false);
  const subscriptionStatus = input.subscription?.status ?? "inactive";
  const isSubscriptionActive =
    ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus);
  const shouldManageBilling = input.summary
    ? isNonFreePlanFamily(input.summary.planFamily)
    : Boolean(input.subscription?.externalSubscriptionId);
  const actionLabel = shouldManageBilling
    ? copy.billing.manageBilling
    : copy.billing.upgradePlan;
  const actionDisabled =
    actionLoading ||
    (shouldManageBilling &&
      input.subscription?.capabilities?.managePortal !== true) ||
    (shouldManageBilling ? !input.teamId : !input.isPersonal && !input.teamId);

  const handleAction = React.useCallback(async () => {
    if (
      shouldManageBilling
        ? input.subscription?.capabilities?.managePortal !== true
        : !billingCheckoutEnabled
    ) {
      return;
    }

    if (shouldManageBilling) {
      if (!input.teamId) {
        return;
      }

      setActionLoading(true);
      try {
        const result = await billingClient.createBillingPortal(input.teamId);

        if (result.portalUrl) {
          trackBillingPortalOpened({
            scope: input.isPersonal ? "personal" : "team",
            source: "settings",
          });
          openBillingPortalWindow(result.portalUrl);
          return;
        }

        toast.error(copy.billing.portalUnavailable);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : copy.billing.unableToOpenPortal,
        );
      } finally {
        setActionLoading(false);
      }
      return;
    }

    if (!input.isPersonal && !input.teamId) {
      return;
    }

    setActionLoading(true);
    try {
      if (input.isPersonal) {
        const result = await billingClient.createPricingCheckout({
          plan: "pro",
          billingInterval: input.billingPeriod,
          source: "dashboard",
          clientReferenceKey: createBillingReferenceKey(
            "personal",
            input.billingPeriod,
          ),
        });
        trackBeginCheckout({
          billingInterval: input.billingPeriod,
          plan: "pro",
          source: "settings",
        });
        openCheckout(result);
        return;
      }

      if (!input.teamId) {
        return;
      }

      const result = await billingClient.createSubscriptionCheckout(
        input.teamId,
        {
          planFamily: "team_standard",
          billingInterval: input.billingPeriod,
          seatCount: Math.max(
            input.teamSeatCount ?? 2,
            input.summary?.seats.used ?? 2,
            2,
          ),
        },
      );
      trackBeginCheckout({
        billingInterval: input.billingPeriod,
        plan: "team",
        seatCount: Math.max(
          input.teamSeatCount ?? 2,
          input.summary?.seats.used ?? 2,
          2,
        ),
        source: "settings",
      });
      openCheckout(result);
    } catch (err) {
      trackCheckoutError({
        billingInterval: input.billingPeriod,
        plan: input.isPersonal ? "pro" : "team",
        source: "settings",
      });
      toast.error(err instanceof Error ? err.message : controls.checkoutError);
    } finally {
      setActionLoading(false);
    }
  }, [
    billingCheckoutEnabled,
    billingClient,
    openCheckout,
    trackBeginCheckout,
    trackBillingPortalOpened,
    trackCheckoutError,
    input.billingPeriod,
    input.isPersonal,
    input.summary?.seats.used,
    input.teamId,
    input.teamSeatCount,
    shouldManageBilling,
    input.subscription?.capabilities?.managePortal,
    copy,
    controls,
  ]);

  return {
    actionDisabled,
    actionLabel,
    actionLoading,
    handleAction,
    isSubscriptionActive,
    shouldManageBilling,
  };
}
