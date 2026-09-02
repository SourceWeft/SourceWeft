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
import { toObjectRecord } from "../../../shared/records";

type CreemServerOptions = {
  apiKey: string;
  testMode?: boolean;
};

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function resolveEntityId(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return readString(toObjectRecord(value), "id");
}

function resolveSubscriptionProductId(subscription: unknown) {
  const record = toObjectRecord(subscription);
  return (
    readString(record, "productId") ??
    readString(record, "product_id") ??
    resolveEntityId(record?.product)
  );
}

export function resolveCreemSubscriptionSeatUpdateItem(input: {
  subscription: unknown;
  seatCount: number;
  fallbackProductId?: string | null;
}) {
  const record = toObjectRecord(input.subscription);
  const items = record?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const firstItem = toObjectRecord(items[0]);
  const itemId = readString(firstItem, "id");
  if (!itemId) {
    return null;
  }

  const productId =
    readString(firstItem, "productId") ??
    readString(firstItem, "product_id") ??
    resolveSubscriptionProductId(input.subscription) ??
    input.fallbackProductId ??
    undefined;
  const priceId =
    readString(firstItem, "priceId") ??
    readString(firstItem, "price_id") ??
    undefined;

  return {
    id: itemId,
    ...(productId ? { productId } : {}),
    ...(priceId ? { priceId } : {}),
    units: input.seatCount,
  };
}

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

  private resolveSubscriptionCustomerId(subscription: unknown) {
    const record =
      subscription && typeof subscription === "object"
        ? (subscription as Record<string, unknown>)
        : null;
    const customer = record?.customer;

    if (typeof customer === "string" && customer.trim()) {
      return customer;
    }

    if (customer && typeof customer === "object") {
      const id = (customer as Record<string, unknown>).id;
      return typeof id === "string" && id.trim() ? id : null;
    }

    return null;
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
          input.kind === "subscription" && input.planFamily === "individual_pro"
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
    let externalCustomerId = input.externalCustomerId ?? null;

    if (!externalCustomerId && input.externalSubscriptionId) {
      const creemClient = createCreemClient(this.options);
      const subscription = await creemClient.subscriptions.get(
        input.externalSubscriptionId,
      );
      externalCustomerId = this.resolveSubscriptionCustomerId(subscription);
    }

    if (!externalCustomerId) {
      throw new BillingError(
        "CREEM_CUSTOMER_ID_MISSING",
        409,
        "Creem customer ID is required to open the billing portal",
      );
    }

    const response = await createPortal(
      this.options as any,
      externalCustomerId,
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
    const item = resolveCreemSubscriptionSeatUpdateItem({
      subscription,
      seatCount: input.seatCount,
      fallbackProductId: input.externalProductId,
    });

    if (!item) {
      throw new BillingError(
        "CREEM_SUBSCRIPTION_ITEM_MISSING",
        502,
        "Creem subscription did not include a subscription item to update",
      );
    }

    if (!item.productId && !item.priceId) {
      throw new BillingError(
        "CREEM_SUBSCRIPTION_ITEM_PRODUCT_MISSING",
        502,
        "Creem subscription item did not include a product or price to update",
      );
    }

    await creemClient.subscriptions.update(input.externalSubscriptionId, {
      items: [item],
      updateBehavior: input.updateBehavior,
    });

    return {
      provider: "creem",
      seatCount: input.seatCount,
    };
  }
}
