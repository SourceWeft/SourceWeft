import type { BetterAuthPlugin } from "better-auth";
import type { BillingRuntimeConfig } from "../server/types";
import type { createCreemSubscriptionSync } from "../server/providers/creem-subscription-sync";

export function createBillingAuthPlugins(_input: {
  mode: "runtime" | "migration";
  config: BillingRuntimeConfig;
  sync: ReturnType<typeof createCreemSubscriptionSync>;
}): BetterAuthPlugin[] {
  // The host handles signed Creem webhooks before Auth routing. Keeping a second
  // plugin route could acknowledge processing failures with HTTP 200.
  return [];
}
