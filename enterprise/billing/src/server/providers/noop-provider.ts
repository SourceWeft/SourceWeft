import { BillingError } from "../errors";
import type {
  BillingProviderAdapter,
  BillingProviderCheckoutInput,
  BillingProviderCheckoutResult,
  BillingProviderPortalInput,
  BillingProviderPortalResult,
  BillingProviderUpdateSeatsInput,
  BillingProviderUpdateSeatsResult,
} from "../types";

function notConfigured(input?: BillingProviderCheckoutInput): never {
  const planLabel =
    input?.planFamily === "individual_pro"
      ? "personal Pro checkout"
      : input?.planFamily === "team_standard"
        ? "team subscription checkout"
        : "billing checkout";

  throw new BillingError(
    "BILLING_PROVIDER_NOT_CONFIGURED",
    503,
    `Billing provider is not configured for ${planLabel}`,
  );
}

export class NoopBillingProvider implements BillingProviderAdapter {
  async createCheckout(
    input: BillingProviderCheckoutInput,
  ): Promise<BillingProviderCheckoutResult> {
    notConfigured(input);
  }

  async createPortal(
    _input: BillingProviderPortalInput,
  ): Promise<BillingProviderPortalResult> {
    notConfigured();
  }

  async updateSubscriptionSeats(
    _input: BillingProviderUpdateSeatsInput,
  ): Promise<BillingProviderUpdateSeatsResult> {
    notConfigured();
  }
}
