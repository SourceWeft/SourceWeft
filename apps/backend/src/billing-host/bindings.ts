import "dotenv/config";
import type { BetterAuthPlugin } from "better-auth";
import type { Hono } from "hono";
import { BillingError } from "@sourceweft/contracts/billing-runtime";
import {
  createCoreBillingRuntime,
  createCoreBillingOrganizationHooks,
  coreDeploymentCapabilities,
} from "./core";
import { assertEditionConfiguration } from "./config";
import { billingHttpPaths } from "./http-paths";
import type { BillingHttpHost } from "./http-host";
import type { CheckResult } from "../checks/types";
assertEditionConfiguration("core", process.env);
export const billingRuntime = createCoreBillingRuntime();
export const billingOrganizationHooks = createCoreBillingOrganizationHooks();
export const getBillingDeploymentCapabilities = coreDeploymentCapabilities;
export const billingSchedulesEnabled = false;
export function getBillingAuthPlugins(
  _mode: "runtime" | "migration",
): BetterAuthPlugin[] {
  return [];
}
export async function handleBillingAuthRequest(
  _request: Request,
): Promise<Response | null> {
  return null;
}
export function registerBillingHttpRoutes(app: Hono, host: BillingHttpHost) {
  for (const [method, route] of billingHttpPaths) {
    app.on(method.toUpperCase(), route, async (c) => {
      if (!(await host.requireSession(c))) throw host.ApiError.unauthorized();
      throw new BillingError(
        "BILLING_UNAVAILABLE",
        501,
        "Commercial billing is not installed in this edition",
      );
    });
  }
}
export async function reconcileBillingSchedule(): Promise<unknown> {
  throw new BillingError(
    "BILLING_UNAVAILABLE",
    501,
    "Billing schedule requires the commercial edition",
  );
}
export async function runBillingCatalogCheck(): Promise<CheckResult> {
  return {
    name: "billing-catalog",
    status: "skipped",
    message: "Commercial billing is not installed.",
    details: {
      unusedCredentialEnv: ["CREEM_API_KEY", "CREEM_WEBHOOK_SECRET"].filter(
        (name) => Boolean(process.env[name]),
      ),
    },
    durationMs: 0,
  };
}

export function validateBillingStartup() {
  assertEditionConfiguration("core", process.env);
}
