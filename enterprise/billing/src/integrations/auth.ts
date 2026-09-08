import { creem } from "@creem_io/better-auth";
import type { BillingRuntimeConfig } from "../server/types";
import type { createCreemSubscriptionSync } from "../server/providers/creem-subscription-sync";

export function createBillingAuthPlugins(input: {
  mode: "runtime" | "migration";
  config: BillingRuntimeConfig;
  sync: ReturnType<typeof createCreemSubscriptionSync>;
}): ReturnType<typeof creem>[] {
  const config = { billing: input.config };
  const isRuntimeMode = input.mode === "runtime";
  const syncCreemSubscriptionEvent = input.sync;
  if (isRuntimeMode && input.config.provider !== "creem") return [];
  return [
    creem({
      apiKey: config.billing.creem.apiKey,
      testMode: config.billing.creem.testMode,
      defaultSuccessUrl: config.billing.defaultSuccessUrl,
      persistSubscriptions: true,
      ...(isRuntimeMode
        ? {
            webhookSecret: config.billing.creem.webhookSecret || undefined,
            onSubscriptionActive: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.active",
                data,
                "active",
              );
            },
            onSubscriptionTrialing: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.trialing",
                data,
                "trialing",
              );
            },
            onSubscriptionPaid: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.paid",
                data,
                "active",
              );
            },
            onSubscriptionPastDue: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.past_due",
                data,
                "past_due",
              );
            },
            onSubscriptionPaused: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.paused",
                data,
                "paused",
              );
            },
            onSubscriptionUnpaid: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.unpaid",
                data,
                "unpaid",
              );
            },
            onSubscriptionCanceled: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.canceled",
                data,
                "canceled",
              );
            },
            onSubscriptionExpired: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.expired",
                data,
                "expired",
              );
            },
            onSubscriptionUpdate: async (data) => {
              await syncCreemSubscriptionEvent(
                "subscription.update",
                data,
                "active",
              );
            },
          }
        : {}),
    }),
  ];
}
