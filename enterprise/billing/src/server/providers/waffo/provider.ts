import { WaffoPancake, TaxCategory } from "@waffo/pancake-ts";
import { BillingError } from "../../errors";
import type {
  BillingProviderAdapter,
  BillingProviderCheckoutInput,
  BillingProviderPortalInput,
  BillingProviderUpdateSeatsInput,
  BillingRuntimeConfig,
  BillingOrderState,
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
  readonly checkoutRetryWindowMs = 23 * 60 * 60 * 1000;
  constructor(
    private readonly config: BillingRuntimeConfig,
    private readonly state: WaffoStateStore,
    client?: WaffoPancake,
  ) {
    this.client = client ?? createWaffoClient(config);
  }
  async checkoutMetadata() {
    const settings = await this.state.getSettings(
      this.config.waffo.merchantId,
      this.config.waffo.environment,
    );
    if (!settings)
      throw new BillingError(
        "WAFFO_SETUP_REQUIRED",
        503,
        "Waffo setup is incomplete",
      );
    return {
      waffoStoreId: settings.storeId,
      waffoMerchantId: settings.merchantId,
      waffoEnvironment: settings.environment,
      waffoProducts: settings.products,
    };
  }
  async inspectCheckout(order: BillingOrderState) {
    if (!order.externalCheckoutId) return "unknown" as const;
    if (
      order.metadata.waffoMerchantId !== this.config.waffo.merchantId ||
      order.metadata.waffoEnvironment !== this.config.waffo.environment
    )
      throw new BillingError(
        "WAFFO_ORDER_BINDING_MISMATCH",
        409,
        "Checkout belongs to another merchant or environment",
      );
    const result = await this.client.graphql.query<{
      checkoutSession: { id: string; status: string } | null;
    }>({
      query: "query($id: ID!) { checkoutSession(id: $id) { id status } }",
      variables: { id: order.externalCheckoutId },
    });
    if (result.errors?.length)
      throw new BillingError(
        "WAFFO_CHECKOUT_QUERY_FAILED",
        502,
        "Unable to resolve previous checkout",
      );
    return result.data?.checkoutSession?.id === order.externalCheckoutId &&
      result.data.checkoutSession.status === "expired"
      ? ("expired" as const)
      : ("unknown" as const);
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
    const savedProducts = input.metadata?.waffoProducts as
      Record<string, string> | undefined;
    const productId =
      input.externalProductId ||
      savedProducts?.[waffoProductKey(input)] ||
      settings?.products[waffoProductKey(input)];
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
        sourceweftCheckoutAttempt: input.previousCheckoutId ?? "initial",
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
