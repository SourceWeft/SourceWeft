import { config } from "../../shared/config";
import { createBillingProvider } from "./provider";
import { BillingService } from "./service";
import { billingStore } from "./store";

const billingProvider = createBillingProvider(config.billing);

export const billingService = new BillingService(
  billingStore,
  config.billing,
  billingProvider,
);

export * from "./errors";
export * from "./types";
