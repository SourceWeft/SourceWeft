import {
  createCheckout,
  createCreemClient,
  createPortal,
} from "@creem_io/better-auth/server";
import type { BillingRuntimeConfig } from "../types";
import type {
  BillingProviderAdapter,
  BillingProviderCheckoutInput,
  BillingProviderCheckoutResult,
  BillingProviderPortalInput,
  BillingProviderPortalResult,
  BillingProviderUpdateSeatsInput,
  BillingProviderUpdateSeatsResult,
} from "../types";
import { BillingError } from "../errors";

type CreemServerOptions = {
  apiKey: string;
  testMode?: boolean;
};

export class CreemBillingProvider implements BillingProviderAdapter {
  private readonly options: CreemServerOptions;
  private readonly defaultSuccessUrl: string;

  constructor(config: BillingRuntimeConfig) {
    this.options = {
      apiKey: config.creem.apiKey,
      testMode: config.creem.testMode,
    };
    this.defaultSuccessUrl = config.defaultSuccessUrl;

    if (!this.options.apiKey) {
      throw new BillingError(
        "CREEM_API_KEY_MISSING",
        500,
        "CREEM_API_KEY is required when BACKEND_BILLING_PROVIDER=creem",
      );
    }
  }

  private resolveProductId(input: BillingProviderCheckoutInput) {
    const productId = input.externalProductId;

    if (!productId) {
      throw new BillingError(
        "CREEM_PRODUCT_ID_MISSING",
        500,
        `Creem product ID is required for billing order ${input.orderId}`,
      );
    }

    return productId;
  }

  private resolveSubscriptionItemId(subscription: unknown) {
    const record =
      subscription && typeof subscription === "object"
        ? (subscription as Record<string, unknown>)
        : null;
    const items = record?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const first = items[0];
    if (!first || typeof first !== "object") {
      return null;
    }

    const itemId = (first as Record<string, unknown>).id;
    return typeof itemId === "string" && itemId.trim() ? itemId : null;
  }

  async createCheckout(
    input: BillingProviderCheckoutInput,
  ): Promise<BillingProviderCheckoutResult> {
    const successUrl = input.successUrl || this.defaultSuccessUrl;
    const productId = this.resolveProductId(input);
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.persistedOrder ? { orderId: input.orderId } : {}),
      userId: input.actorUserId,
      kind: input.kind,
      quantity: input.quantity,
      ...(input.planFamily ? { planFamily: input.planFamily } : {}),
      ...(input.billingInterval
        ? { billingInterval: input.billingInterval }
        : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.unitType ? { unitType: input.unitType } : {}),
      ...(input.unitAmount ? { unitAmount: input.unitAmount } : {}),
      ...(input.grantedCredits ? { grantedCredits: input.grantedCredits } : {}),
      ...(input.grantedPages ? { grantedPages: input.grantedPages } : {}),
    };

    const response = await createCheckout(
      this.options as any,
      {
        productId,
        units:
          input.kind === "subscription" &&
          input.planFamily === "individual_pro"
            ? undefined
            : input.quantity,
        successUrl,
        customer: {
          email: input.actorEmail,
        },
        skipTrial: true,
        metadata,
        requestId: `order:${input.orderId}`,
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
      externalCheckoutId: null,
      externalCustomerId: null,
    };
  }

  async createPortal(
    input: BillingProviderPortalInput,
  ): Promise<BillingProviderPortalResult> {
    if (!input.externalCustomerId) {
      throw new BillingError(
        "CREEM_CUSTOMER_ID_MISSING",
        409,
        "Creem customer ID is required to open the billing portal",
      );
    }

    const response = await createPortal(
      this.options as any,
      input.externalCustomerId,
    );

    return {
      provider: "creem",
      portalUrl: response.url,
    };
  }

  async updateSubscriptionSeats(
    input: BillingProviderUpdateSeatsInput,
  ): Promise<BillingProviderUpdateSeatsResult> {
    const creemClient = createCreemClient(this.options);
    const subscription = await creemClient.subscriptions.get(
      input.externalSubscriptionId,
    );
    const itemId = this.resolveSubscriptionItemId(subscription);

    if (!itemId) {
      throw new BillingError(
        "CREEM_SUBSCRIPTION_ITEM_MISSING",
        502,
        "Creem subscription did not include a subscription item to update",
      );
    }

    await creemClient.subscriptions.update(input.externalSubscriptionId, {
      items: [
        {
          id: itemId,
          units: input.seatCount,
        },
      ],
      updateBehavior: "proration-charge-immediately",
    });

    return {
      provider: "creem",
      seatCount: input.seatCount,
    };
  }
}
