import { BillingService } from "./service";
import { createBillingProvider } from "./provider";
import {
  createBillingRuntime,
  createBillingOrganizationHooks,
} from "./runtime";
import type { BillingRuntimeConfig } from "./types";
import type { BillingStore } from "./store-port";
import type { BillingAlertSink, BillingServiceHost } from "./host";
import { BillingError } from "./errors";

export function createBilling(input: {
  config: BillingRuntimeConfig;
  store: BillingStore;
  host: BillingServiceHost;
  alerts: BillingAlertSink;
}) {
  if (
    !input.host ||
    typeof input.host.createTeamOrganization !== "function" ||
    typeof input.host.ensureMembershipWorkspace !== "function" ||
    typeof input.host.organizationMetadata !== "function" ||
    !input.host.logger ||
    typeof input.host.logger.error !== "function" ||
    !input.alerts ||
    typeof input.alerts.trigger !== "function" ||
    typeof input.alerts.resolve !== "function"
  ) {
    throw new BillingError(
      "BILLING_HOST_MISSING",
      500,
      "Commercial billing requires explicit host services",
    );
  }
  const service = new BillingService(
    input.store,
    input.config,
    createBillingProvider(input.config),
    input.alerts,
    input.host,
  );
  return {
    service,
    runtime: createBillingRuntime(service),
    organizationHooks: createBillingOrganizationHooks(service),
  };
}

export { BillingService } from "./service";
export {
  createBillingRuntime,
  createBillingOrganizationHooks,
} from "./runtime";
export type { BillingStore } from "./store-port";
export type {
  BillingServiceHost,
  BillingAlertSink,
  BillingLogger,
} from "./host";
export type { BillingRuntimeConfig } from "./types";
