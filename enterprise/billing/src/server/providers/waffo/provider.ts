import { WaffoPancake, TaxCategory } from "@waffo/pancake-ts";
import { BillingError } from "../../errors";
import type {
  BillingProviderAdapter,
  BillingProviderCheckoutInput,
  BillingProviderPortalInput,
  BillingProviderUpdateSeatsInput,
  BillingRuntimeConfig,
} from "../../types";
import { centsToDisplay, createWaffoClient } from "./client";
import type { WaffoStateStore } from "./state";

export function waffoProductKey(
  input: Pick<
    BillingProviderCheckoutInput,
    "kind" | "planFamily" | "billingInterval"
  >,
) {
  return input.kind === "subscription"
    ? `${input.planFamily}:${input.billingInterval}`
    : input.kind;
}
export class WaffoBillingProvider implements BillingProviderAdapter {
  readonly client: WaffoPancake;
  constructor(
    private readonly config: BillingRuntimeConfig,
    private readonly state: WaffoStateStore,
    client?: WaffoPancake,
  ) {
    this.client = client ?? createWaffoClient(config);
  }
  async createCheckout(input: BillingProviderCheckoutInput) {
    if (!input.persistedOrder)
      throw new BillingError(
        "WAFFO_PERSISTED_ORDER_REQUIRED",
        409,
        "Waffo checkout requires a persisted billing order",
      );
    if (input.currency?.toUpperCase() !== "USD")
      throw new BillingError(
        "WAFFO_CURRENCY_UNSUPPORTED",
        400,
        "This billing catalog uses USD",
      );
    const settings = await this.state.getSettings(
      this.config.waffo.merchantId,
      this.config.waffo.environment,
    );
    const productId = settings?.products[waffoProductKey(input)];
    if (!settings || !productId)
      throw new BillingError(
        "WAFFO_SETUP_REQUIRED",
        503,
        "Initialize the Waffo store and billing catalog before checkout",
      );
    const amount = centsToDisplay(input.amountTotal ?? 0);
    const session = await this.client.checkout.createSession({
      productId,
      currency: "USD",
      buyerEmail: input.actorEmail,
      successUrl: input.successUrl || this.config.defaultSuccessUrl,
      withTrial: false,
      priceSnapshot: { amount, taxCategory: TaxCategory.SaaS },
      orderMerchantExternalId: input.orderId,
      metadata: {
        sourceweftOrderId: input.orderId,
        sourceweftUserId: input.actorUserId,
        sourceweftTeamId: input.teamId ?? "",
        sourceweftKind: input.kind,
        sourceweftQuantity: String(input.quantity),
      },
    });
    const url = new URL(session.checkoutUrl);
    if (url.protocol !== "https:")
      throw new BillingError(
        "WAFFO_CHECKOUT_URL_INVALID",
        502,
        "Waffo returned an invalid checkout URL",
      );
    return {
      provider: "waffo" as const,
      checkoutUrl: url.toString(),
      externalCheckoutId: session.sessionId,
      externalCustomerId: null,
      externalProductId: productId,
      expiresAt: session.expiresAt,
      metadata: {
        waffoStoreId: settings.storeId,
        waffoEnvironment: settings.environment,
        waffoMerchantId: settings.merchantId,
      },
    };
  }
  async createPortal(_input: BillingProviderPortalInput) {
    return {
      provider: "waffo" as const,
      portalUrl: "https://pancake.waffo.ai/consumer/portal/login",
    };
  }
  async updateSubscriptionSeats(
    _input: BillingProviderUpdateSeatsInput,
  ): Promise<never> {
    throw new BillingError(
      "WAFFO_SEAT_UPDATE_UNSUPPORTED",
      409,
      "Waffo does not support changing subscription seat quantities through this integration",
    );
  }
}
