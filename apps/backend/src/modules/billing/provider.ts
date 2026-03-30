import { BillingError } from "./errors";
import { CreemBillingProvider } from "./providers/creem-provider";
import { NoopBillingProvider } from "./providers/noop-provider";
import type { BillingProviderAdapter, BillingRuntimeConfig } from "./types";

export function createBillingProvider(
  runtimeConfig: BillingRuntimeConfig,
): BillingProviderAdapter {
  if (runtimeConfig.provider === "creem") {
    return new CreemBillingProvider(runtimeConfig);
  }

  if (
    runtimeConfig.provider === "none" ||
    runtimeConfig.provider === "manual"
  ) {
    return new NoopBillingProvider();
  }

  throw new BillingError(
    "BILLING_PROVIDER_UNSUPPORTED",
    400,
    `Billing provider '${runtimeConfig.provider}' is not supported in this release`,
  );
}
