import { config } from "../../shared/config";
import { opsAlertService } from "../ops";
import { createBillingProvider } from "./provider";
import { createCreemSubscriptionSync } from "./providers/creem-subscription-sync";
import { BillingService } from "./service";
import { billingStore } from "./store";

const billingProvider = createBillingProvider(config.billing);

export const billingService = new BillingService(
  billingStore,
  config.billing,
  billingProvider,
);

export const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
  billing: billingService,
  alerts: opsAlertService,
});

export * from "./errors";
export * from "./types";
