import Stripe from "stripe";
import { BillingError } from "../../errors";
import type {
  BillingProviderAdapter,
  BillingProviderCheckoutInput,
  BillingProviderPortalInput,
  BillingProviderUpdateSeatsInput,
  BillingRuntimeConfig,
} from "../../types";

export function stripeId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}
export function stripeProductKey(
  input: Pick<
    BillingProviderCheckoutInput,
    "kind" | "planFamily" | "billingInterval"
  >,
) {
  return input.kind === "subscription"
    ? `${input.planFamily}:${input.billingInterval}`
    : input.kind;
}
export function createStripeClient(config: BillingRuntimeConfig) {
  const pattern = config.stripe.testMode
    ? /^(sk|rk)_test_\S+$/
    : /^(sk|rk)_live_\S+$/;
  if (!pattern.test(config.stripe.secretKey))
    throw new BillingError(
      "STRIPE_SECRET_KEY_INVALID",
      500,
      "Stripe secret key must match the selected test/live mode",
    );
  return new Stripe(config.stripe.secretKey, {
    apiVersion: Stripe.API_VERSION,
    timeout: 30_000,
    maxNetworkRetries: 2,
  });
}
export class StripeBillingProvider implements BillingProviderAdapter {
  readonly client: Stripe;
  private accountPromise?: Promise<string>;
  constructor(
    private readonly config: BillingRuntimeConfig,
    client?: Stripe,
  ) {
    this.client = client ?? createStripeClient(config);
  }
  async getCheckoutScope(): Promise<string> {
    if (!this.accountPromise)
      this.accountPromise = this.client.accounts
        .retrieveCurrent()
        .then((account) => {
          if (!account.id?.startsWith("acct_"))
            throw new BillingError(
              "STRIPE_ACCOUNT_INVALID",
              502,
              "Unable to identify the Stripe account",
            );
          return account.id;
        })
        .catch((error) => {
          this.accountPromise = undefined;
          throw error;
        });
    return this.accountPromise;
  }
  async createCheckout(input: BillingProviderCheckoutInput) {
    if (!input.persistedOrder)
      throw new BillingError(
        "STRIPE_PERSISTED_ORDER_REQUIRED",
        409,
        "Stripe checkout requires a persisted billing order",
      );
    const amount = input.amountTotal;
    if (
      !amount ||
      !Number.isSafeInteger(amount) ||
      !Number.isSafeInteger(input.quantity) ||
      input.quantity <= 0 ||
      amount % input.quantity !== 0
    )
      throw new BillingError(
        "STRIPE_AMOUNT_INVALID",
        400,
        "Stripe checkout requires whole minor currency units and a valid quantity",
      );
    if (input.currency?.toLowerCase() !== "usd")
      throw new BillingError(
        "STRIPE_CURRENCY_UNSUPPORTED",
        400,
        "This billing catalog uses USD",
      );
    if (
      input.kind === "subscription" &&
      !["monthly", "yearly"].includes(input.billingInterval ?? "")
    )
      throw new BillingError(
        "STRIPE_INTERVAL_INVALID",
        400,
        "A monthly or yearly interval is required",
      );
    const accountId = await this.getCheckoutScope();
    const key = stripeProductKey(input);
    const metadata = {
      sourceweftOrderId: input.orderId,
      sourceweftAccountId: accountId,
      sourceweftUserId: input.actorUserId,
      sourceweftProductKey: key,
      sourceweftUnitAmount: String(amount / input.quantity),
    };
    const subscription = input.kind === "subscription";
    const session = await this.client.checkout.sessions.create(
      {
        mode: subscription ? "subscription" : "payment",
        adaptive_pricing: { enabled: false },
        automatic_tax: { enabled: false },
        allow_promotion_codes: false,
        client_reference_id: input.orderId,
        customer_email: input.actorEmail,
        ...(subscription
          ? { subscription_data: { metadata } }
          : {
              customer_creation: "always" as const,
              payment_intent_data: { metadata },
            }),
        metadata,
        success_url: input.successUrl || this.config.defaultSuccessUrl,
        ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
        line_items: [
          {
            quantity: input.quantity,
            price_data: {
              currency: "usd",
              unit_amount: amount / input.quantity,
              product_data: {
                name: subscription
                  ? `SourceWeft ${input.planFamily === "team_standard" ? "Team" : "Pro"} ${input.billingInterval}`
                  : `SourceWeft ${input.unitAmount} ${input.unitType === "credit" ? "credits" : "pages"}`,
                metadata: { sourceweftProductKey: key },
              },
              ...(subscription
                ? {
                    recurring: {
                      interval:
                        input.billingInterval === "yearly"
                          ? ("year" as const)
                          : ("month" as const),
                    },
                  }
                : {}),
            },
          },
        ],
      },
      {
        idempotencyKey: `sourceweft-checkout:${input.orderId}:${input.previousCheckoutId ?? "initial"}`,
      },
    );
    if (session.livemode !== !this.config.stripe.testMode)
      throw new BillingError(
        "STRIPE_ENVIRONMENT_MISMATCH",
        502,
        "Stripe returned a checkout in the wrong environment",
      );
    if (!session.url || new URL(session.url).protocol !== "https:")
      throw new BillingError(
        "STRIPE_CHECKOUT_URL_INVALID",
        502,
        "Stripe returned no valid hosted checkout URL",
      );
    return {
      provider: "stripe" as const,
      checkoutUrl: session.url,
      externalCheckoutId: session.id,
      externalCustomerId: stripeId(session.customer),
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
      metadata: {
        stripeAccountId: accountId,
        stripeTestMode: this.config.stripe.testMode,
      },
    };
  }
  async createPortal(input: BillingProviderPortalInput) {
    let customer = input.externalCustomerId;
    if (!customer && input.externalSubscriptionId)
      customer = stripeId(
        (await this.client.subscriptions.retrieve(input.externalSubscriptionId))
          .customer,
      );
    if (!customer)
      throw new BillingError(
        "STRIPE_CUSTOMER_MISSING",
        409,
        "No Stripe customer is bound to this subscription",
      );
    const portal = await this.client.billingPortal.sessions.create({
      customer,
      return_url: new URL(
        "/dashboard",
        this.config.defaultSuccessUrl,
      ).toString(),
    });
    return { provider: "stripe" as const, portalUrl: portal.url };
  }
  async updateSubscriptionSeats(input: BillingProviderUpdateSeatsInput) {
    const subscription = await this.client.subscriptions.retrieve(
      input.externalSubscriptionId,
      { expand: ["latest_invoice"] },
    );
    const item = subscription.items.data[0];
    if (
      subscription.livemode !== !this.config.stripe.testMode ||
      subscription.metadata.sourceweftAccountId !==
        (await this.getCheckoutScope()) ||
      subscription.items.data.length !== 1 ||
      !item
    )
      throw new BillingError(
        "STRIPE_SUBSCRIPTION_BINDING_MISMATCH",
        409,
        "Subscription does not match this Stripe billing integration",
      );
    if (
      !Number.isSafeInteger(input.seatCount) ||
      input.seatCount < 2 ||
      input.seatCount > 99
    )
      throw new BillingError(
        "STRIPE_SEATS_INVALID",
        400,
        "Team seats must be between 2 and 99",
      );
    if (
      input.externalProductId &&
      stripeId(item.price.product) !== input.externalProductId
    )
      throw new BillingError(
        "STRIPE_PRODUCT_MISMATCH",
        409,
        "Subscription product does not match the stored product",
      );
    if (
      subscription.status !== "active" ||
      subscription.pending_update ||
      typeof subscription.latest_invoice !== "object" ||
      subscription.latest_invoice?.status !== "paid"
    )
      throw new BillingError(
        "STRIPE_SUBSCRIPTION_UNPAID",
        409,
        "A fully paid active subscription is required for a seat update",
      );
    const expectedPrice =
      item.price.recurring?.interval === "year"
        ? this.config.catalog.teamStandardYearlyAmountCents
        : this.config.catalog.teamStandardMonthlyAmountCents;
    if (
      !subscription.metadata.sourceweftProductKey?.startsWith(
        "team_standard:",
      ) ||
      item.price.currency !== "usd" ||
      item.price.unit_amount !== expectedPrice
    )
      throw new BillingError(
        "STRIPE_SEAT_PRICE_MISMATCH",
        409,
        "The Stripe seat price differs from the current billing catalog",
      );
    if (item.quantity === input.seatCount)
      return { provider: "stripe" as const, seatCount: input.seatCount };
    const updated = await this.client.subscriptions.update(
      subscription.id,
      {
        items: [{ id: item.id, quantity: input.seatCount }],
        proration_behavior:
          input.updateBehavior === "proration-charge-immediately"
            ? "always_invoice"
            : input.updateBehavior === "proration-charge"
              ? "create_prorations"
              : "none",
        payment_behavior: "error_if_incomplete",
        expand: ["latest_invoice"],
      },
      {
        idempotencyKey: `sourceweft-seats:${subscription.id}:${item.quantity}:${input.seatCount}:${stripeId(subscription.latest_invoice) ?? item.current_period_start}`,
      },
    );
    if (
      updated.pending_update ||
      updated.status !== "active" ||
      updated.items.data[0]?.quantity !== input.seatCount ||
      typeof updated.latest_invoice !== "object" ||
      updated.latest_invoice?.status !== "paid"
    )
      throw new BillingError(
        "STRIPE_SEAT_UPDATE_NOT_CONFIRMED",
        409,
        "Stripe has not confirmed the seat change; no local quota was changed",
      );
    return { provider: "stripe" as const, seatCount: input.seatCount };
  }
}
