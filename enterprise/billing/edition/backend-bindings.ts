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
import {
  PostgresWaffoStateStore,
  WaffoWebhookService,
  registerWaffoWebhook,
} from "@sourceweft/billing/integrations/waffo";
import { waffoCatalogProducts } from "@sourceweft/billing/waffo-setup";
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
const store = new PostgresBillingStore(
  database,
  createBillingMembershipSource(database),
);
const waffoState = new PostgresWaffoStateStore(database);
let instance: ReturnType<typeof createBilling> | undefined;
function billing() {
  if (!instance) {
    validateBillingConfiguration(billingConfig);
    instance = createBilling({
      config: billingConfig,
      store,
      waffoState,
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
  }
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
let waffoInbox: WaffoWebhookService | undefined;
function waffo() {
  return (waffoInbox ??= new WaffoWebhookService({
    config: billingConfig,
    state: waffoState,
    store,
    billing: billing().service,
    logger,
  }));
}
export function registerBillingHttpRoutes(app: Hono, host: BillingHttpHost) {
  createBillingHttpRoutes(billing().service, host)(app);
  if (billingConfig.provider === "waffo") registerWaffoWebhook(app, waffo());
}
export const billingSchedulesEnabled =
  billingConfig.provider === "waffo" ||
  (billingConfig.teamBillingEnabled && billingConfig.reconcileEnabled);
export async function reconcileBillingSchedule() {
  if (billingConfig.provider === "waffo") await waffo().drain();
  if (billingConfig.teamBillingEnabled && billingConfig.reconcileEnabled)
    return createBillingSchedule(billing().service, alerts, logger)();
}
export function getBillingDeploymentCapabilities(): DeploymentCapabilities {
  const checkout =
    billingConfig.saasEnabled &&
    ["creem", "waffo"].includes(billingConfig.provider);
  return {
    edition: "commercial",
    billingRuntimeApiVersion: 1,
    billing: {
      available: true,
      provider: billingConfig.provider,
      paymentEnvironment:
        billingConfig.provider === "waffo"
          ? billingConfig.waffo.environment
          : billingConfig.provider === "creem"
            ? billingConfig.creem.testMode
              ? "test"
              : "prod"
            : undefined,
      mode: billingConfig.mode,
      checkout,
      teamSubscriptions: checkout && billingConfig.teamBillingEnabled,
      topup:
        checkout &&
        Boolean(
          billingConfig.provider === "waffo" ||
          billingConfig.creem.creditTopupProductId ||
          billingConfig.creem.pageTopupProductId,
        ),
    },
  };
}
export async function runBillingCatalogCheck(): Promise<CheckResult> {
  validateBillingConfiguration(billingConfig);
  if (billingConfig.provider === "waffo") {
    const settings = await waffoState.getSettings(
      billingConfig.waffo.merchantId,
      billingConfig.waffo.environment,
    );
    const missing = waffoCatalogProducts(billingConfig)
      .map((product) => product.key)
      .filter((key) => !settings?.products[key]);
    if (missing.length)
      return {
        name: "billing-catalog",
        status: "error",
        message: "Waffo catalog setup is incomplete.",
        details: { missingProducts: missing },
        hints: ["Run the commercial waffo:setup command."],
        durationMs: 0,
      };
  }
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
