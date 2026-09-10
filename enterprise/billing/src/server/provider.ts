import { StripeBillingProvider } from "./providers/stripe/provider";
import { WaffoBillingProvider } from "./providers/waffo/provider";
import type { WaffoStateStore } from "./providers/waffo/state";
import { BillingError } from "./errors";
import { CreemBillingProvider } from "./providers/creem-provider";
import { NoopBillingProvider } from "./providers/noop-provider";
import type { BillingProviderAdapter, BillingRuntimeConfig } from "./types";

const PROVIDER_FACTORIES: Record<
  string,
  (config: BillingRuntimeConfig) => BillingProviderAdapter
> = {
  stripe: (config) => new StripeBillingProvider(config),
  creem: (config) => new CreemBillingProvider(config),
  none: () => new NoopBillingProvider(),
  manual: () => new NoopBillingProvider(),
};

export function createBillingProvider(
  runtimeConfig: BillingRuntimeConfig,
  waffoState?: WaffoStateStore,
): BillingProviderAdapter {
  if (runtimeConfig.provider === "waffo") {
    if (!waffoState)
      throw new BillingError(
        "WAFFO_STATE_STORE_MISSING",
        500,
        "Waffo requires a durable settings store",
      );
    return new WaffoBillingProvider(runtimeConfig, waffoState);
  }
  const factory = PROVIDER_FACTORIES[runtimeConfig.provider];
  if (!factory) {
    throw new BillingError(
      "BILLING_PROVIDER_UNSUPPORTED",
      400,
      `Billing provider '${runtimeConfig.provider}' is not supported in this release`,
    );
  }
  return factory(runtimeConfig);
}
