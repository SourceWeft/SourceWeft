// SourceWeft Commercial License: generated from enterprise/billing/edition.
import "dotenv/config";
import type { Hono } from "hono";
import type {
  BillingRuntime,
  BillingOrganizationHooks,
} from "@sourceweft/contracts/billing-runtime";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";
import {
  createBilling,
  type BillingAlertSink,
} from "@sourceweft/billing/server";
import { PostgresBillingStore } from "@sourceweft/billing/postgres";
import {
  readBillingConfig,
  validateBillingConfiguration,
} from "@sourceweft/billing/config";
import {
  createCreemSubscriptionSync,
  createCreemScheduledCancelWebhook,
} from "@sourceweft/billing/integrations/creem";
import { createBillingAuthPlugins } from "@sourceweft/billing/integrations/auth";
import { createBillingHttpRoutes } from "@sourceweft/billing/integrations/http";
import { createBillingSchedule } from "@sourceweft/billing/integrations/jobs";
import { database } from "@sourceweft/db";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { createSourceweftOrganizationMetadata } from "../modules/auth/organization-metadata";
import { createBillingMembershipSource } from "./membership-source";
import { assertEditionConfiguration } from "./config";
import type { BillingHttpHost } from "./http-host";
import type { CheckResult } from "../checks/types";
assertEditionConfiguration("commercial", process.env);
const billingConfig = readBillingConfig(process.env, config.auth.webBaseUrl);
const alerts: BillingAlertSink = {
  async trigger(input) {
    return (await import("../modules/ops")).opsAlertService.trigger(input);
  },
  async resolve(key) {
    return (await import("../modules/ops")).opsAlertService.resolve(key);
  },
};
let instance: ReturnType<typeof createBilling> | undefined;
function billing() {
  validateBillingConfiguration(billingConfig);
  if (!instance)
    instance = createBilling({
      config: billingConfig,
      store: new PostgresBillingStore(
        database,
        createBillingMembershipSource(database),
      ),
      alerts,
      host: {
        logger,
        organizationMetadata: createSourceweftOrganizationMetadata,
        async createTeamOrganization(input) {
          return (
            await import("../modules/workspace")
          ).workspaceService.createTeamOrganization(input);
        },
        async ensureMembershipWorkspace(input) {
          return (
            await import("../modules/workspace")
          ).workspaceService.ensureMembershipWorkspace(input);
        },
      },
    });
  return instance;
}
export const billingRuntime: BillingRuntime = {
  getExecutionState: (...args) => billing().runtime.getExecutionState(...args),
  settleModelUsage: (...args) => billing().runtime.settleModelUsage(...args),
  meterIngestion: (...args) => billing().runtime.meterIngestion(...args),
  reconcileProviderCost: (...args) =>
    billing().runtime.reconcileProviderCost(...args),
};
export const billingOrganizationHooks: BillingOrganizationHooks = {
  provisionAccount: (...args) =>
    billing().organizationHooks.provisionAccount(...args),
  beforeAddMember: (...args) =>
    billing().organizationHooks.beforeAddMember(...args),
  beforeInviteMember: (...args) =>
    billing().organizationHooks.beforeInviteMember(...args),
  beforeAcceptInvitation: (...args) =>
    billing().organizationHooks.beforeAcceptInvitation(...args),
};
const sync: ReturnType<typeof createCreemSubscriptionSync> = (...args) =>
  createCreemSubscriptionSync({
    billing: billing().service,
    alerts,
    config: billingConfig,
    logger,
  })(...args);
export function getBillingAuthPlugins(
  mode: "runtime" | "migration",
): ReturnType<typeof createBillingAuthPlugins> {
  if (mode === "runtime") validateBillingConfiguration(billingConfig);
  return createBillingAuthPlugins({ mode, config: billingConfig, sync });
}
export const handleBillingAuthRequest = createCreemScheduledCancelWebhook({
  config: billingConfig,
  logger,
  sync,
});
export function registerBillingHttpRoutes(app: Hono, host: BillingHttpHost) {
  createBillingHttpRoutes(billing().service, host)(app);
}
export const billingSchedulesEnabled =
  billingConfig.teamBillingEnabled && billingConfig.reconcileEnabled;
export function reconcileBillingSchedule() {
  return createBillingSchedule(billing().service, alerts, logger)();
}
export function getBillingDeploymentCapabilities(): DeploymentCapabilities {
  const checkout =
    billingConfig.saasEnabled && billingConfig.provider === "creem";
  return {
    edition: "commercial",
    billingRuntimeApiVersion: 1,
    billing: {
      available: true,
      mode: billingConfig.mode,
      checkout,
      teamSubscriptions: checkout && billingConfig.teamBillingEnabled,
      topup:
        checkout &&
        Boolean(
          billingConfig.creem.creditTopupProductId ||
          billingConfig.creem.pageTopupProductId,
        ),
    },
  };
}
export async function runBillingCatalogCheck(): Promise<CheckResult> {
  validateBillingConfiguration(billingConfig);
  return {
    name: "billing-catalog",
    status: "ok",
    message: "Billing catalog is valid.",
    durationMs: 0,
  };
}

export function validateBillingStartup() {
  validateBillingConfiguration(billingConfig);
}
