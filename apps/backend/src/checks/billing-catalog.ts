import { config } from "../shared/config";
import { validateBillingCatalog } from "../modules/billing/catalog";
import type { CheckResult } from "./types";

export async function runBillingCatalogCheck(): Promise<CheckResult> {
  const startedAt = performance.now();

  try {
    validateBillingCatalog({ runtimeConfig: config.billing });
    return {
      name: "billing-catalog",
      status: "ok",
      message: "Billing catalog is valid.",
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      name: "billing-catalog",
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Billing catalog validation failed.",
      details:
        error && typeof error === "object" && "details" in error
          ? ((error as { details?: Record<string, unknown> }).details ?? {})
          : {},
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}
