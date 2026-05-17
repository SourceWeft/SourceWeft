"use client";

import {
  getPricingConfig,
  planFamilyToPricingPlanId,
} from "@sourceweft/contracts/pricing";
import { trackEvent, type AnalyticsParams } from "./analytics";

type BillingInterval = "monthly" | "yearly";
type CheckoutPlan = "pro" | "team";
type CheckoutSource = "landing" | "dashboard" | "settings";
type CheckoutItem = { item_id: string; item_name: string };

function normalizeBillingInterval(
  value: string | null | undefined,
): BillingInterval | null {
  return value === "monthly" || value === "yearly" ? value : null;
}

function centsToDollars(cents: number | null | undefined) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) {
    return undefined;
  }

  return cents / 100;
}

function compactParams(params: AnalyticsParams) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  ) as AnalyticsParams;
}

function getPlanPriceCents(input: {
  billingInterval: BillingInterval;
  plan: CheckoutPlan;
  seatCount?: number;
}) {
  const plan = getPricingConfig().find(
    (item) => item.id === input.plan,
  );
  if (!plan) {
    return undefined;
  }

  const unitPrice =
    input.billingInterval === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
  return input.plan === "team"
    ? unitPrice * Math.max(input.seatCount ?? 1, 1)
    : unitPrice;
}

function checkoutItem(input: {
  billingInterval: BillingInterval | null | undefined;
  plan: CheckoutPlan | string | null | undefined;
}): CheckoutItem {
  const plan = input.plan === "team" ? "team" : "pro";
  const interval = input.billingInterval === "monthly" ? "monthly" : "yearly";
  const label = plan === "team" ? "Team" : "Pro";
  return {
    item_id: `${plan}_${interval}`,
    item_name: `${label} ${interval}`,
  };
}

export function trackSignUp(method: string) {
  trackEvent("sign_up", { method });
}

export function trackLogin(method: string) {
  trackEvent("login", { method });
}

export function trackAuthError(input: {
  action: "sign_up" | "login";
  method: string;
  surface: "desktop" | "mobile" | "web";
}) {
  trackEvent("auth_error", input);
}

export function trackBeginCheckout(input: {
  billingInterval: BillingInterval;
  plan: CheckoutPlan;
  seatCount?: number;
  source: CheckoutSource;
}) {
  trackEvent(
    "begin_checkout",
    compactParams({
      billing_interval: input.billingInterval,
      currency: "USD",
      items: [checkoutItem(input)],
      plan: input.plan,
      seat_count: input.seatCount,
      source: input.source,
      value: centsToDollars(getPlanPriceCents(input)),
    }),
  );
}

export function trackCheckoutError(input: {
  billingInterval: BillingInterval;
  plan: CheckoutPlan;
  source: CheckoutSource;
}) {
  trackEvent("checkout_error", {
    billing_interval: input.billingInterval,
    plan: input.plan,
    source: input.source,
  });
}

export function trackBillingPortalOpened(input: {
  scope: "personal" | "team";
  source: "dashboard" | "settings";
}) {
  trackEvent("billing_portal_opened", input);
}

export function trackPurchase(input: {
  amountTotal: number | null;
  billingInterval: string | null;
  currency: string | null;
  orderId: string;
  planFamily: string | null;
}) {
  const plan = planFamilyToPricingPlanId(input.planFamily);
  if (plan === "free" || !plan) {
    return;
  }
  const billingInterval = normalizeBillingInterval(input.billingInterval);

  trackEvent(
    "purchase",
    compactParams({
      billing_interval: billingInterval,
      currency: (input.currency ?? "USD").toUpperCase(),
      items: [
        checkoutItem({
          billingInterval,
          plan,
        }),
      ],
      plan: input.planFamily,
      transaction_id: input.orderId,
      value: centsToDollars(input.amountTotal),
    }),
  );
}

export function trackChatMessageSent(input: {
  commandUsed: boolean;
  hasImages: boolean;
  hasSources: boolean;
  skillCount: number;
  sourceCount: number;
  surface: "empty_state" | "thread";
  toolCount: number;
}) {
  trackEvent("chat_message_sent", {
    command_used: input.commandUsed,
    has_images: input.hasImages,
    has_sources: input.hasSources,
    skill_count: input.skillCount,
    source_count: input.sourceCount,
    surface: input.surface,
    tool_count: input.toolCount,
  });
}

export function trackSkillSelected(skillCount: number) {
  trackEvent("skill_selected", {
    skill_count: skillCount,
    surface: "composer",
  });
}

export function trackSourceAttached(sourceCount: number) {
  trackEvent("source_attached", {
    source_count: sourceCount,
    surface: "composer",
  });
}

export function trackTeamInvitationAccepted() {
  trackEvent("team_invitation_accepted", { source: "invitation_link" });
}
