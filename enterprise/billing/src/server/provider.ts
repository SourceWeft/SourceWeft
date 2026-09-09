import { BillingError } from "./errors";
import { CreemBillingProvider } from "./providers/creem-provider";
import { NoopBillingProvider } from "./providers/noop-provider";
import type { BillingProviderAdapter, BillingRuntimeConfig } from "./types";

const PROVIDER_FACTORIES: Record<
  string,
  (config: BillingRuntimeConfig) => BillingProviderAdapter
> = {
  creem: (config) => new CreemBillingProvider(config),
  none: () => new NoopBillingProvider(),
  manual: () => new NoopBillingProvider(),
};

export function createBillingProvider(
  runtimeConfig: BillingRuntimeConfig,
): BillingProviderAdapter {
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
