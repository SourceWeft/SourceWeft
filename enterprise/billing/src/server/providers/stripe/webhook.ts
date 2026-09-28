import Stripe from "stripe";
import { BillingError } from "../../errors";
import type {
  BillingRuntimeConfig,
  BillingOrderState,
  TeamSubscriptionSnapshot,
} from "../../types";
import type { BillingStore } from "../../store-port";
import type { BillingService } from "../../service";
import type { BillingLogger } from "../../host";
import type { PaymentReversalInput } from "../../payment-reversal";
import { StripeBillingProvider, stripeId } from "./provider";
import type { StripeInboxStore } from "./state";

export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;
const supported = new Set<string>(STRIPE_WEBHOOK_EVENTS);
const eventKey = (event: Stripe.Event) =>
  `${event.livemode ? "live" : "test"}:${event.id}`;
function objectId(event: Stripe.Event): string {
  const object = event.data?.object as { id?: unknown } | undefined;
  if (typeof object?.id !== "string" || !object.id)
    throw new BillingError(
      "STRIPE_EVENT_INVALID",
      400,
      "Stripe event has no resource identifier",
    );
  return object.id;
}
// A missing PaymentIntent/invoice/subscription is a permanent data problem
// (the referenced resource is gone), not a transient one: retrying it every
// 30s would never succeed. Only used while resolving a `charge.*` reference,
// where "not found" already has a defined fallback (the next lookup, or
// `unmatched`); every other Stripe error keeps propagating so the receipt is
// marked `failed` and retried.
function isStripeNotFoundError(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeError &&
    (error.statusCode === 404 || error.code === "resource_missing")
  );
}
async function notFoundAsNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (isStripeNotFoundError(error)) return null;
    throw error;
  }
}
export class StripeWebhookService {
  private draining = false;
  constructor(
    private readonly input: {
      config: BillingRuntimeConfig;
      provider: StripeBillingProvider;
      state: StripeInboxStore;
      store: BillingStore;
      billing: BillingService;
      logger: BillingLogger;
    },
  ) {}
  async receive(raw: string, signature: string | undefined) {
    let event: Stripe.Event;
    try {
      event = this.input.provider.client.webhooks.constructEvent(
        raw,
        signature ?? "",
        this.input.config.stripe.webhookSecret,
      );
    } catch {
      throw new BillingError(
        "STRIPE_SIGNATURE_INVALID",
        401,
        "Invalid Stripe webhook signature",
      );
    }
    if (!event?.id || !event.type || !event.data?.object)
      throw new BillingError(
        "STRIPE_EVENT_INVALID",
        400,
        "Invalid Stripe event envelope",
      );
    if (event.livemode !== !this.input.config.stripe.testMode)
      throw new BillingError(
        "STRIPE_ENVIRONMENT_MISMATCH",
        403,
        "Stripe webhook mode does not match this deployment",
      );
    if (supported.has(event.type)) objectId(event);
    if (event.account)
      throw new BillingError(
        "STRIPE_CONNECT_UNSUPPORTED",
        403,
        "This endpoint does not accept Connect account events",
      );
    return this.input.store.insertWebhookEvent({
      provider: "stripe",
      providerEventId: eventKey(event),
      eventType: event.type,
      payload: event as unknown as Record<string, unknown>,
      metadata: {},
      teamId: null,
      externalSubscriptionId: null,
    });
  }
  kick() {
    setImmediate(() => {
      void this.drain().catch(() =>
        this.input.logger.error(
          "Stripe inbox drain failed; scheduler will retry",
        ),
      );
    });
  }
  private async state(
    id: string,
    status: "processed" | "ignored" | "failed",
    code: string | null = null,
    order?: BillingOrderState,
  ) {
    await this.input.store.updateWebhookEventState(id, {
      status,
      processedAt: status === "failed" ? null : new Date().toISOString(),
      errorCode: code,
      errorMessage: code,
      teamId: order?.teamId ?? null,
      externalSubscriptionId: order?.externalSubscriptionId ?? null,
    });
  }
  /** The order id recorded in a subscription's metadata, if any. */
  private async subscriptionOrderId(
    subscriptionId: string,
  ): Promise<string | null> {
    return (
      (await this.input.provider.client.subscriptions.retrieve(subscriptionId))
        .metadata.sourceweftOrderId ?? null
    );
  }
  private async reference(event: Stripe.Event): Promise<string | null> {
    const object = event.data.object as {
      id: string;
      metadata?: Record<string, string>;
      client_reference_id?: string | null;
      parent?: Stripe.Invoice.Parent | null;
      payment_intent?: string | Stripe.PaymentIntent | null;
    };
    const direct =
      object.metadata?.sourceweftOrderId ??
      object.parent?.subscription_details?.metadata?.sourceweftOrderId;
    if (direct) return direct;
    if (event.type.startsWith("invoice.")) {
      const invoice = await this.input.provider.client.invoices.retrieve(
        object.id,
      );
      const subscriptionId = stripeId(
        invoice.parent?.subscription_details?.subscription,
      );
      if (subscriptionId) return this.subscriptionOrderId(subscriptionId);
    }
    if (event.type.startsWith("charge.")) {
      const paymentIntentId = stripeId(object.payment_intent);
      if (!paymentIntentId) return null;
      const order = await this.input.billing.findOrderByProviderPaymentId(
        "stripe",
        paymentIntentId,
      );
      if (order) return order.id;
      // A deleted/expired PaymentIntent, invoice or subscription is a
      // permanent "not found", not a transient failure: fall through the
      // remaining lookups (and ultimately to `unmatched`) instead of
      // retrying the receipt forever.
      const paymentIntent = await notFoundAsNull(
        this.input.provider.client.paymentIntents.retrieve(paymentIntentId),
      );
      if (paymentIntent?.metadata.sourceweftOrderId)
        return paymentIntent.metadata.sourceweftOrderId;
      const payments = await notFoundAsNull(
        this.input.provider.client.invoicePayments.list({
          payment: {
            type: "payment_intent",
            payment_intent: paymentIntentId,
          },
          limit: 1,
        }),
      );
      const invoiceId = stripeId(payments?.data[0]?.invoice);
      if (!invoiceId) return null;
      const invoice = await notFoundAsNull(
        this.input.provider.client.invoices.retrieve(invoiceId),
      );
      const subscriptionId = stripeId(
        invoice?.parent?.subscription_details?.subscription,
      );
      if (!subscriptionId) return null;
      const subscription = await notFoundAsNull(
        this.input.provider.client.subscriptions.retrieve(subscriptionId),
      );
      return subscription?.metadata.sourceweftOrderId ?? null;
    }
    return null;
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const event of await this.input.state.pendingEvents(
        this.input.config.stripe.testMode,
      )) {
        const record = await this.input.store.getWebhookEventByProviderEventId(
          "stripe",
          eventKey(event),
        );
        if (!record || ["processed", "ignored"].includes(record.status))
          continue;
        try {
          if (!supported.has(event.type)) {
            await this.state(record.id, "ignored", "STRIPE_EVENT_UNSUPPORTED");
            continue;
          }
          const reference = await this.reference(event);
          if (!reference) {
            if (event.type.startsWith("charge."))
              await this.unmatchedReversal(event, record.id, null);
            else
              await this.state(record.id, "ignored", "STRIPE_UNRELATED_ORDER");
            continue;
          }
          await this.input.state.withLock(
            `${event.livemode}:${reference}`,
            async () => {
              try {
                const latest =
                  await this.input.store.getWebhookEventByProviderEventId(
                    "stripe",
                    eventKey(event),
                  );
                if (!latest || ["processed", "ignored"].includes(latest.status))
                  return;
                if (latest.status === "failed")
                  await this.input.store.incrementWebhookEventAttempt(
                    latest.id,
                    {
                      eventType: latest.eventType,
                      teamId: latest.teamId,
                      externalSubscriptionId: latest.externalSubscriptionId,
                      payload: latest.payload,
                      metadata: latest.metadata,
                    },
                  );
                const order = await this.input.billing.getOrder(reference);
                if (
                  !order ||
                  order.provider !== "stripe" ||
                  order.metadata.stripeTestMode !==
                    this.input.config.stripe.testMode ||
                  order.metadata.stripeAccountId !==
                    (await this.input.provider.getCheckoutScope())
                ) {
                  if (event.type.startsWith("charge."))
                    return this.unmatchedReversal(event, record.id, reference);
                  throw new BillingError(
                    "STRIPE_ORDER_BINDING_MISMATCH",
                    422,
                    "Stripe order, account or environment does not match",
                  );
                }
                const result = await this.process(event, order);
                const ignored =
                  result === true
                    ? null
                    : result === false
                      ? "STRIPE_AWAITING_PAYMENT"
                      : result.ignore;
                await this.state(
                  record.id,
                  ignored ? "ignored" : "processed",
                  ignored,
                  (await this.input.billing.getOrder(order.id)) ?? order,
                );
              } catch (error) {
                await this.failed(event, record.id, error);
              }
            },
          );
        } catch (error) {
          await this.failed(event, record.id, error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
  /**
   * A refund or dispute with no usable local order: no PaymentIntent, a
   * charge this deployment did not sell, or an order id (`resolvedOrderId`)
   * that this database does not hold or that is bound to another Stripe
   * account or mode, e.g. a test account shared across environments. None of
   * these heals on retry, so raise the unmatched alert with what a manual
   * follow-up needs and ignore the receipt rather than retry it forever.
   */
  private async unmatchedReversal(
    event: Stripe.Event,
    receiptId: string,
    resolvedOrderId: string | null,
  ) {
    const object = event.data.object as {
      amount?: number;
      amount_refunded?: number;
      currency?: string;
      payment_intent?: string | { id: string } | null;
    };
    await this.input.billing.reportPaymentReversalNotice({
      reason: "unmatched",
      provider: "stripe",
      providerReference: objectId(event),
      amount: object.amount ?? null,
      currency: object.currency ?? null,
      metadata: {
        eventType: event.type,
        paymentIntentId: stripeId(object.payment_intent),
        ...(object.amount_refunded === undefined
          ? {}
          : { amountRefunded: object.amount_refunded }),
        ...(resolvedOrderId ? { resolvedOrderId } : {}),
      },
    });
    await this.state(receiptId, "ignored", "STRIPE_UNRELATED_ORDER");
  }
  private async failed(event: Stripe.Event, receiptId: string, error: unknown) {
    const latest = await this.input.store.getWebhookEventByProviderEventId(
      "stripe",
      eventKey(event),
    );
    if (latest && ["processed", "ignored"].includes(latest.status)) return;
    const code =
      error instanceof BillingError ? error.code : "STRIPE_PROCESSING_FAILED";
    await this.state(receiptId, "failed", code);
    this.input.logger.error(
      "Stripe webhook processing failed; durable retry retained",
      { receiptId, eventType: event.type, code },
    );
  }
  private mode(livemode: boolean) {
    if (livemode !== !this.input.config.stripe.testMode)
      throw new BillingError(
        "STRIPE_ENVIRONMENT_MISMATCH",
        422,
        "Stripe resource is in the wrong mode",
      );
  }
  private async session(id: string, order: BillingOrderState) {
    const session = await this.input.provider.client.checkout.sessions.retrieve(
      id,
      { expand: ["line_items.data.price.product"] },
    );
    this.mode(session.livemode);
    if (
      session.id !== order.externalCheckoutId ||
      session.client_reference_id !== order.id ||
      session.metadata?.sourceweftOrderId !== order.id ||
      session.metadata.sourceweftAccountId !== order.metadata.stripeAccountId
    )
      throw new BillingError(
        "STRIPE_SESSION_MISMATCH",
        422,
        "Checkout session does not match the persisted purchase",
      );
    if (session.payment_status === "paid") {
      const item = session.line_items?.data[0];
      if (
        session.amount_total !== order.amountTotal ||
        session.currency !== order.currency?.toLowerCase() ||
        !item ||
        session.line_items?.has_more ||
        session.line_items?.data.length !== 1 ||
        item.quantity !== order.quantity ||
        item.price?.unit_amount !== (order.amountTotal ?? 0) / order.quantity
      )
        throw new BillingError(
          "STRIPE_AMOUNT_MISMATCH",
          422,
          "Paid checkout amount or line item differs from the purchase",
        );
    }
    return session;
  }
  /**
   * Read-modify-write of one order under its row lock. A payment reversal can
   * commit on the row after this handler's unlocked read of it; writing that
   * stale read back would erase the reversal columns. `change` sees the
   * locked row and returns only the fields to set, or null to leave it as is.
   */
  private async updateOrderLocked(
    orderId: string,
    change: (current: BillingOrderState) => Partial<BillingOrderState> | null,
  ): Promise<BillingOrderState | null> {
    const { store } = this.input;
    return store.runInTransaction(async (client) => {
      const current = await store.getOrderByIdForUpdate(orderId, client);
      if (!current)
        throw new BillingError(
          "BILLING_ORDER_NOT_FOUND",
          404,
          "Billing order not found",
          { orderId },
        );
      const changes = change(current);
      if (!changes) return null;
      return store.updateOrder(
        { ...current, ...changes, updatedAt: new Date().toISOString() },
        client,
      );
    });
  }
  /**
   * Refunds and disputes on a resolved order, handed to the reversal core.
   * `amount_refunded` is the charge's cumulative refunded total in minor
   * units, so a redelivered event (same reversal id) or a later lower total
   * never debits twice or re-grants. A refund that fails after it was
   * reversed is not detected (its events are not subscribed). An opened
   * dispute only raises an alert; a closed one reverses only when lost.
   */
  private async reversal(
    event: Stripe.Event,
    order: BillingOrderState,
  ): Promise<true | { ignore: string }> {
    const { billing } = this.input;
    let input: PaymentReversalInput;
    if (event.type === "charge.refunded") {
      const charge = event.data.object;
      input = {
        orderId: order.id,
        provider: "stripe",
        reversalId: `charge:${charge.id}:refunded:${charge.amount_refunded}`,
        kind: "refund",
        amount: { refundedTotal: charge.amount_refunded },
        paidAmount: charge.amount,
        currency: charge.currency,
        metadata: {
          chargeId: charge.id,
          paymentIntentId: stripeId(charge.payment_intent),
        },
      };
    } else if (
      event.type === "charge.dispute.created" ||
      event.type === "charge.dispute.closed"
    ) {
      const dispute = event.data.object;
      const metadata = {
        chargeId: stripeId(dispute.charge),
        paymentIntentId: stripeId(dispute.payment_intent),
        disputeStatus: dispute.status,
      };
      if (event.type === "charge.dispute.created") {
        await billing.reportPaymentReversalNotice({
          reason: "dispute_opened",
          provider: "stripe",
          providerReference: dispute.id,
          orderId: order.id,
          teamId: order.teamId,
          amount: dispute.amount,
          currency: dispute.currency,
          metadata,
        });
        return true;
      }
      if (dispute.status !== "lost") return true;
      input = {
        orderId: order.id,
        provider: "stripe",
        reversalId: dispute.id,
        kind: "chargeback",
        amount: { refundedTotal: dispute.amount },
        paidAmount: dispute.amount,
        currency: dispute.currency,
        metadata,
      };
    } else return { ignore: "STRIPE_EVENT_UNSUPPORTED" };
    const result = await billing.applyPaymentReversal(input);
    return result.outcome === "rejected"
      ? { ignore: "STRIPE_REVERSAL_REJECTED" }
      : true;
  }
  private async process(
    event: Stripe.Event,
    order: BillingOrderState,
  ): Promise<boolean | { ignore: string }> {
    const client = this.input.provider.client;
    if (event.type.startsWith("charge.")) return this.reversal(event, order);
    if (event.type.startsWith("checkout.session.")) {
      if (!order.externalCheckoutId) {
        const recovered = await client.checkout.sessions.retrieve(
          objectId(event),
        );
        this.mode(recovered.livemode);
        if (
          recovered.client_reference_id !== order.id ||
          recovered.metadata?.sourceweftOrderId !== order.id ||
          recovered.metadata.sourceweftAccountId !==
            order.metadata.stripeAccountId
        )
          throw new BillingError(
            "STRIPE_SESSION_MISMATCH",
            422,
            "Cannot recover an unrelated checkout",
          );
        order = (await this.updateOrderLocked(order.id, () => ({
          externalCheckoutId: recovered.id,
        })))!;
      }
      if (objectId(event) !== order.externalCheckoutId) {
        const previous = await client.checkout.sessions.retrieve(
          objectId(event),
        );
        this.mode(previous.livemode);
        if (
          previous.client_reference_id === order.id &&
          previous.metadata?.sourceweftOrderId === order.id &&
          previous.metadata.sourceweftAccountId ===
            order.metadata.stripeAccountId &&
          previous.payment_status !== "paid"
        )
          return false;
        throw new BillingError(
          "STRIPE_SESSION_MISMATCH",
          422,
          "Payment belongs to a different checkout session",
        );
      }
      const session = await this.session(objectId(event), order);
      if (session.payment_status !== "paid") {
        if (
          session.status === "expired" ||
          event.type === "checkout.session.async_payment_failed"
        ) {
          const expired = session.status === "expired";
          const checkoutId = order.externalCheckoutId;
          await this.updateOrderLocked(order.id, (current) =>
            current.paymentStatus === "paid" ||
            current.externalCheckoutId !== checkoutId
              ? null
              : {
                  status: expired ? "expired" : "payment_failed",
                  paymentStatus: expired ? "expired" : "failed",
                },
          );
        }
        return false;
      }
      if (session.status !== "complete") return false;
      if (order.kind === "subscription") {
        if (session.mode !== "subscription" || !stripeId(session.subscription))
          throw new BillingError(
            "STRIPE_ORDER_KIND_MISMATCH",
            422,
            "Subscription checkout has no subscription",
          );
        return this.subscription(stripeId(session.subscription)!, order);
      }
      if (session.mode !== "payment" || !stripeId(session.payment_intent))
        throw new BillingError(
          "STRIPE_PAYMENT_MISSING",
          422,
          "One-time checkout has no successful payment",
        );
      await this.input.billing.fulfillOrder({
        orderId: order.id,
        externalPaymentId: stripeId(session.payment_intent),
        externalCustomerId: stripeId(session.customer),
        externalProductId: stripeId(
          session.line_items?.data[0]?.price?.product,
        ),
      });
      return true;
    }
    if (order.kind !== "subscription")
      throw new BillingError(
        "STRIPE_ORDER_KIND_MISMATCH",
        422,
        "Subscription event cannot fulfill a top-up",
      );
    if (event.type.startsWith("invoice.")) {
      const invoice = await client.invoices.retrieve(objectId(event));
      this.mode(invoice.livemode);
      const subscriptionId = stripeId(
        invoice.parent?.subscription_details?.subscription,
      );
      if (!subscriptionId) return false;
      return this.subscription(subscriptionId, order);
    }
    return this.subscription(objectId(event), order);
  }
  private async subscription(
    id: string,
    order: BillingOrderState,
  ): Promise<boolean> {
    const observed = order.teamId
      ? await this.input.store.getSubscriptionByTeam(order.teamId)
      : null;
    if (
      observed &&
      observed.externalSubscriptionId !== id &&
      order.status === "fulfilled"
    )
      return false;
    const expectedVersion = observed?.version;
    // Always re-read under the order lock; a delayed event must not restore stale state.
    const sub = await this.input.provider.client.subscriptions.retrieve(id, {
      expand: ["latest_invoice"],
    });
    this.mode(sub.livemode);
    if (
      sub.metadata.sourceweftOrderId !== order.id ||
      sub.metadata.sourceweftAccountId !== order.metadata.stripeAccountId ||
      (order.externalSubscriptionId && order.externalSubscriptionId !== sub.id)
    )
      throw new BillingError(
        "STRIPE_SUBSCRIPTION_MISMATCH",
        422,
        "Subscription is not bound to this purchase",
      );
    const item = sub.items.data[0];
    const quantity = item?.quantity ?? 0;
    const interval = order.billingInterval === "yearly" ? "year" : "month";
    if (
      !item ||
      sub.items.data.length !== 1 ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 99 ||
      (order.planFamily === "individual_pro" && quantity !== 1) ||
      item.price.currency !== order.currency?.toLowerCase() ||
      item.price.unit_amount !== (order.amountTotal ?? 0) / order.quantity ||
      item.price.recurring?.interval !== interval ||
      item.price.recurring.interval_count !== 1 ||
      (order.externalProductId &&
        stripeId(item.price.product) !== order.externalProductId)
    )
      throw new BillingError(
        "STRIPE_SUBSCRIPTION_PRODUCT_MISMATCH",
        422,
        "Subscription price, interval or seats differ from the purchased plan",
      );
    if (sub.status === "past_due") {
      const context = await this.input.billing.getSubscriptionWebhookContext(
        "stripe",
        sub.id,
      );
      const existing = context.subscription;
      if (!existing) return false;
      await this.input.billing.syncSubscriptionSnapshot({
        ...existing,
        status: "past_due",
        confirmCoverage: false,
        expectedVersion,
        seatCount: context.account?.seatCount ?? order.quantity,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        metadata: {
          ...existing.metadata,
          stripeUnpaidInvoiceId: stripeId(sub.latest_invoice),
        },
      });
      return true;
    }
    const active = sub.status === "active";
    if (
      !active &&
      !["canceled", "unpaid", "incomplete_expired", "paused"].includes(
        sub.status,
      )
    )
      return false;
    let invoice =
      typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
    if (active && !invoice && sub.latest_invoice)
      invoice = await this.input.provider.client.invoices.retrieve(
        stripeId(sub.latest_invoice)!,
      );
    if (active && (sub.pending_update || invoice?.status !== "paid"))
      return false;
    if (active) {
      const context = await this.input.billing.getSubscriptionWebhookContext(
        "stripe",
        sub.id,
      );
      const previousInvoice =
        context.subscription?.metadata.stripeLatestInvoiceId;
      if (
        context.account &&
        quantity > context.account.seatCount &&
        (!previousInvoice || previousInvoice === invoice?.id)
      )
        return false;
    }
    const start = item.current_period_start * 1000;
    const end = item.current_period_end * 1000;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      (active && end <= Date.now())
    )
      throw new BillingError(
        "STRIPE_PERIOD_INVALID",
        422,
        "Subscription has no usable paid period",
      );
    if (active && order.status !== "fulfilled") {
      if (!order.externalCheckoutId)
        throw new BillingError(
          "STRIPE_SESSION_MISSING",
          422,
          "Subscription has no original checkout",
        );
      const original = await this.session(order.externalCheckoutId, order);
      if (
        original.payment_status !== "paid" ||
        stripeId(original.subscription) !== sub.id ||
        quantity !== order.quantity
      )
        throw new BillingError(
          "STRIPE_INITIAL_PAYMENT_MISSING",
          422,
          "Initial subscription checkout is not paid or does not match",
        );
      await this.input.billing.fulfillOrder({
        orderId: order.id,
        externalSubscriptionId: sub.id,
        externalCustomerId: stripeId(sub.customer),
        externalProductId: stripeId(item.price.product),
        externalSubscriptionItemId: item.id,
        currentPeriodStart: new Date(start).toISOString(),
        currentPeriodEnd: new Date(end).toISOString(),
        status: "active",
      });
    }
    const current = await this.input.billing.getOrder(order.id);
    if (
      !current?.teamId ||
      current.status !== "fulfilled" ||
      !order.planFamily ||
      !order.billingInterval
    )
      return false;
    const snapshot: TeamSubscriptionSnapshot = {
      teamId: current.teamId,
      provider: "stripe",
      confirmCoverage: active,
      expectedVersion:
        order.status === "fulfilled" ? expectedVersion : undefined,
      planFamily: order.planFamily,
      status: active
        ? "active"
        : sub.status === "paused"
          ? "paused"
          : sub.status === "unpaid"
            ? "unpaid"
            : "canceled",
      billingInterval: order.billingInterval,
      currentPeriodStart: new Date(start).toISOString(),
      currentPeriodEnd: new Date(end).toISOString(),
      externalCustomerId: stripeId(sub.customer),
      externalSubscriptionId: sub.id,
      externalSubscriptionItemId: item.id,
      externalProductId: stripeId(item.price.product),
      billingOrderId: order.id,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      seatCount: quantity,
      metadata: {
        ...current.metadata,
        stripeLatestInvoiceId: stripeId(sub.latest_invoice),
      },
    };
    await this.input.billing.syncSubscriptionSnapshot(snapshot);
    return true;
  }
}
