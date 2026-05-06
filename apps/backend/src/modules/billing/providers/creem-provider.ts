import { createCheckout, createPortal } from "@creem_io/better-auth/server";
import type { BillingRuntimeConfig } from "../types";
import type {
  BillingProviderAdapter,
  BillingProviderCheckoutInput,
  BillingProviderCheckoutResult,
  BillingProviderPortalInput,
  BillingProviderPortalResult,
} from "../types";
import { BillingError } from "../errors";

type CreemServerOptions = {
  apiKey: string;
  testMode?: boolean;
};

export class CreemBillingProvider implements BillingProviderAdapter {
  private readonly options: CreemServerOptions;
  private readonly teamStandardProductId: string;
  private readonly defaultSuccessUrl: string;

  constructor(config: BillingRuntimeConfig) {
    this.options = {
      apiKey: config.creem.apiKey,
      testMode: config.creem.testMode,
    };
    this.teamStandardProductId = config.creem.teamStandardProductId;
    this.defaultSuccessUrl = config.creem.defaultSuccessUrl;

    if (!this.options.apiKey) {
      throw new BillingError(
        "CREEM_API_KEY_MISSING",
        500,
        "CREEM_API_KEY is required when BACKEND_BILLING_PROVIDER=creem",
      );
    }

    if (!this.teamStandardProductId) {
      throw new BillingError(
        "CREEM_PRODUCT_ID_MISSING",
        500,
        "CREEM_TEAM_STANDARD_PRODUCT_ID is required for team subscriptions",
      );
    }
  }

  async createCheckout(
    input: BillingProviderCheckoutInput,
  ): Promise<BillingProviderCheckoutResult> {
    const successUrl = input.successUrl || this.defaultSuccessUrl;

    const response = await createCheckout(
      this.options as any,
      {
        productId: this.teamStandardProductId,
        units: input.seatCount,
        successUrl,
        customer: {
          email: input.actorEmail,
        },
        metadata: {
          teamId: input.teamId,
          planFamily: input.planFamily,
          actorUserId: input.actorUserId,
          seatCount: input.seatCount,
        },
        requestId: `team-subscription:${input.teamId}:${Date.now()}`,
      } as any,
    );

    if (!response.url) {
      throw new BillingError(
        "CREEM_CHECKOUT_URL_MISSING",
        502,
        "Creem checkout did not return a checkout URL",
      );
    }

    return {
      provider: "creem",
      checkoutUrl: response.url,
    };
  }

  async createPortal(
    input: BillingProviderPortalInput,
  ): Promise<BillingProviderPortalResult> {
    const response = await createPortal(
      this.options as any,
      {
        customerId: input.externalCustomerId,
        metadata: {
          teamId: input.teamId,
          actorUserId: input.actorUserId,
        },
      } as any,
    );

    return {
      provider: "creem",
      portalUrl: response.url,
    };
  }
}
