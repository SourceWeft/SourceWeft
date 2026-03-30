import { BillingError } from "../errors";
import type {
  BillingProviderAdapter,
  BillingProviderCancelInput,
  BillingProviderCancelResult,
  BillingProviderCheckoutInput,
  BillingProviderCheckoutResult,
  BillingProviderPortalInput,
  BillingProviderPortalResult,
} from "../types";

function notConfigured(): never {
  throw new BillingError(
    "BILLING_PROVIDER_NOT_CONFIGURED",
    503,
    "Billing provider is not configured for team subscriptions",
  );
}

export class NoopBillingProvider implements BillingProviderAdapter {
  async createCheckout(
    _input: BillingProviderCheckoutInput,
  ): Promise<BillingProviderCheckoutResult> {
    notConfigured();
  }

  async createPortal(
    _input: BillingProviderPortalInput,
  ): Promise<BillingProviderPortalResult> {
    notConfigured();
  }

  async cancelSubscription(
    _input: BillingProviderCancelInput,
  ): Promise<BillingProviderCancelResult> {
    notConfigured();
  }
}
