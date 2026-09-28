import { stableSerialize } from "../../service-helpers";
import { createHash } from "node:crypto";
import { verifyWebhook, type WebhookEvent } from "@waffo/pancake-ts";
import type {
  BillingRuntimeConfig,
  BillingOrderState,
  TeamSubscriptionSnapshot,
} from "../../types";
import type { BillingStore } from "../../store-port";
import type { BillingService } from "../../service";
import type { BillingLogger } from "../../host";
import { BillingError } from "../../errors";
import { updateOrderLocked } from "../../order-locking";
import { displayToCents } from "./client";
import type { WaffoSettings, WaffoStateStore } from "./state";

export const WAFFO_WEBHOOK_EVENTS = [
  "order.completed",
  "subscription.activated",
  "subscription.renewed",
  "subscription.recovered",
  "subscription.payment_succeeded",
  "subscription.canceling",
  "subscription.uncanceled",
  "subscription.canceled",
  "subscription.past_due",
  "refund.succeeded",
  "refund.failed",
] as const;
const supported = new Set<string>(WAFFO_WEBHOOK_EVENTS);
const domainStatuses: Record<string, readonly string[]> = {
  "subscription.activated": ["active"],
  "subscription.renewed": ["active", "canceling"],
  "subscription.recovered": ["active"],
  "subscription.uncanceled": ["active"],
  "subscription.canceling": ["canceling"],
  "subscription.canceled": ["canceled"],
  "subscription.past_due": ["past_due"],
};
export const waffoEventKey = (event: WebhookEvent) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        event.mode,
        event.storeId,
        event.eventType,
        event.eventId,
      ]),
    )
    .digest("hex");

/**
 * A refund amount that is missing or does not parse as a display amount:
 * both are "no usable figure" to the caller, which treats them identically
 * (an `amount_unavailable` notice) rather than letting a malformed string
 * throw and turn into a permanently failing, endlessly retried receipt.
 */
function parseRefundAmount(value: string | undefined): number | null {
  if (!value) return null;
  try {
    return displayToCents(value);
  } catch {
    return null;
  }
}

type Verify = (
  raw: string,
  signature: string | undefined,
  environment: "test" | "prod",
) => WebhookEvent;
export class WaffoWebhookService {
  private draining = false;
  constructor(
    private readonly input: {
      config: BillingRuntimeConfig;
      state: WaffoStateStore;
      store: BillingStore;
      billing: BillingService;
      logger: BillingLogger;
      verify?: Verify;
    },
  ) {}
  private async settings() {
    const { config, state } = this.input;
    const settings = await state.getSettings(
      config.waffo.merchantId,
      config.waffo.environment,
    );
    if (!settings)
      throw new BillingError(
        "WAFFO_SETUP_REQUIRED",
        503,
        "Waffo store setup is incomplete",
      );
    return settings;
  }
  async receive(raw: string, signature: string | undefined) {
    const { config, store } = this.input;
    let event: WebhookEvent;
    try {
      event = this.input.verify
        ? this.input.verify(raw, signature, config.waffo.environment)
        : verifyWebhook(raw, signature, {
            environment: config.waffo.environment,
          });
    } catch {
      throw new BillingError(
        "WAFFO_SIGNATURE_INVALID",
        401,
        "Invalid Waffo webhook signature",
      );
    }
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      ![
        event.id,
        event.eventId,
        event.eventType,
        event.timestamp,
        event.storeId,
      ].every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 512,
      ) ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    )
      throw new BillingError(
        "WAFFO_EVENT_INVALID",
        400,
        "Invalid Waffo event envelope",
      );
    if (event.mode !== config.waffo.environment)
      throw new BillingError(
        "WAFFO_ENVIRONMENT_MISMATCH",
        403,
        "Webhook environment does not match this deployment",
      );
    const settings = await this.settings();
    if (event.storeId !== settings.storeId)
      throw new BillingError(
        "WAFFO_STORE_MISMATCH",
        403,
        "Webhook store does not match this deployment",
      );
    if (
      !event.id ||
      !event.eventId ||
      !event.eventType ||
      !Number.isFinite(Date.parse(event.timestamp)) ||
      !event.data ||
      typeof event.data.orderId !== "string" ||
      !/^ORD_[A-Za-z0-9]+$/.test(event.data.orderId)
    )
      throw new BillingError(
        "WAFFO_EVENT_INVALID",
        400,
        "Invalid Waffo event envelope",
      );
    const existing = await store.getWebhookEventByProviderEventId(
      "waffo",
      waffoEventKey(event),
    );
    if (existing) {
      if (
        stableSerialize(existing.payload.data) !== stableSerialize(event.data)
      )
        throw new BillingError(
          "WAFFO_EVENT_CONFLICT",
          409,
          "A business event was redelivered with different data",
        );
      return existing;
    }
    const recorded = await store.insertWebhookEvent({
      provider: "waffo",
      providerEventId: waffoEventKey(event),
      eventType: event.eventType,
      teamId: null,
      externalSubscriptionId: event.eventType.startsWith("subscription.")
        ? event.data.orderId
        : null,
      payload: event as unknown as Record<string, unknown>,
      metadata: { waffoMerchantId: settings.merchantId },
    });
    this.input.logger.info("Waffo webhook durably received", {
      eventId: event.id,
      eventType: event.eventType,
      mode: event.mode,
      receiptId: recorded.id,
    });
    return recorded;
  }
  kick() {
    setImmediate(() => {
      void this.drain().catch(() => {
        this.input.logger.error(
          "Waffo inbox drain failed; scheduler will retry",
        );
      });
    });
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const settings = await this.settings();
      for (const event of await this.input.state.pendingEvents(settings)) {
        await this.input.state.withLock(
          `order:${settings.merchantId}:${event.mode}:${event.data.orderMerchantExternalId ?? event.data.orderId}`,
          async () => {
            const record =
              await this.input.store.getWebhookEventByProviderEventId(
                "waffo",
                waffoEventKey(event),
              );
            if (
              !record ||
              record.status === "processed" ||
              record.status === "ignored"
            )
              return;
            try {
              await this.process(event, settings, record.id);
            } catch (error) {
              await this.input.store.updateWebhookEventState(record.id, {
                status: "failed",
                teamId: record.teamId,
                externalSubscriptionId: record.externalSubscriptionId,
                processedAt: null,
                errorCode:
                  error instanceof BillingError
                    ? error.code
                    : "WAFFO_PROCESSING_FAILED",
                errorMessage:
                  error instanceof BillingError
                    ? error.message
                    : "Waffo webhook processing failed",
              });
              this.input.logger.error(
                "Waffo webhook processing failed; durable retry retained",
                {
                  receiptId: record.id,
                  eventType: event.eventType,
                  code:
                    error instanceof BillingError
                      ? error.code
                      : "WAFFO_PROCESSING_FAILED",
                },
              );
            }
          },
        );
      }
    } finally {
      this.draining = false;
    }
  }
  private async ignore(receiptId: string, reason: string) {
    await this.input.store.updateWebhookEventState(receiptId, {
      status: "ignored",
      processedAt: new Date().toISOString(),
      teamId: null,
      externalSubscriptionId: null,
      errorCode: reason,
      errorMessage: null,
    });
  }
  private async process(
    event: WebhookEvent,
    settings: WaffoSettings,
    receiptId: string,
  ) {
    const { billing, store } = this.input;
    if (!supported.has(event.eventType))
      return this.ignore(receiptId, "WAFFO_EVENT_UNSUPPORTED");
    const isRefund =
      event.eventType === "refund.succeeded" ||
      event.eventType === "refund.failed";
    const reference = event.data.orderMerchantExternalId;
    if (!reference || !event.data.orderMetadata?.sourceweftOrderId) {
      // A refund with no local reference is an operator problem, not a
      // transient one: notice-and-ignore rather than retry it forever.
      if (isRefund) return this.unmatchedRefund(event, receiptId);
      return this.ignore(receiptId, "WAFFO_UNRELATED_ORDER");
    }
    if (reference !== event.data.orderMetadata.sourceweftOrderId)
      throw new BillingError(
        "WAFFO_ORDER_MISMATCH",
        422,
        "Waffo order references do not match",
      );
    const order = await billing.getOrder(reference);
    if (!order) {
      if (isRefund) return this.unmatchedRefund(event, receiptId);
      throw new BillingError(
        "WAFFO_ORDER_NOT_FOUND",
        422,
        "Waffo local billing order was not found",
      );
    }
    this.validateOrder(event, order, settings);
    if (isRefund) return this.processRefund(event, order, receiptId);
    const expectedProductKey =
      order.kind === "subscription"
        ? `${order.planFamily}:${order.billingInterval}`
        : order.kind;
    if (event.data.productMetadata?.sourceweftProductKey !== expectedProductKey)
      throw new BillingError(
        "WAFFO_PRODUCT_MISMATCH",
        422,
        "Payment product does not match the checkout catalog item",
      );
    const previousAt =
      typeof order.metadata.waffoLastEventAt === "string"
        ? Date.parse(order.metadata.waffoLastEventAt)
        : -Infinity;
    if (
      (Date.parse(event.timestamp) < previousAt ||
        order.metadata.waffoLastEventType === "subscription.canceled") &&
      event.eventType !== "order.completed"
    )
      return this.ignore(receiptId, "WAFFO_STALE_EVENT");
    if (event.eventType === "order.completed") {
      if (
        order.kind === "subscription" ||
        event.data.orderStatus !== "completed" ||
        event.data.paymentStatus !== "succeeded" ||
        !event.data.paymentId
      )
        throw new BillingError(
          "WAFFO_PAYMENT_INVALID",
          422,
          "One-time payment is not completed",
        );
      this.validateAmount(event, order);
      await billing.fulfillOrder({
        orderId: order.id,
        externalPaymentId: event.data.paymentId,
        externalProductId: order.externalProductId,
        metadata: { waffoOrderId: event.data.orderId },
      });
    } else {
      if (
        order.kind !== "subscription" ||
        !order.planFamily ||
        !order.billingInterval
      )
        throw new BillingError(
          "WAFFO_ORDER_KIND_MISMATCH",
          422,
          "Subscription event does not belong to a subscription checkout",
        );
      // Charge events intentionally carry no period: domain events own entitlement renewal.
      if (event.eventType === "subscription.payment_succeeded") {
        if (event.data.paymentStatus !== "succeeded" || !event.data.paymentId)
          throw new BillingError(
            "WAFFO_PAYMENT_INVALID",
            422,
            "Subscription charge is not successful",
          );
        this.validateAmount(event, order);
      } else {
        const confirmsCoverage = [
          "subscription.activated",
          "subscription.renewed",
          "subscription.recovered",
        ].includes(event.eventType);
        if (
          event.data.billingPeriod &&
          event.data.billingPeriod !== order.billingInterval
        )
          throw new BillingError(
            "WAFFO_PERIOD_MISMATCH",
            422,
            "Subscription billing period differs from checkout",
          );
        const start = Date.parse(event.data.currentPeriodStart ?? "");
        const end = Date.parse(event.data.currentPeriodEnd ?? "");
        if (
          (confirmsCoverage ||
            (order.status !== "fulfilled" &&
              ["active", "canceling"].includes(
                event.data.orderStatus ?? "",
              ))) &&
          (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        )
          throw new BillingError(
            "WAFFO_PERIOD_INVALID",
            422,
            "Subscription event is missing a valid period",
          );
        const status = event.data.orderStatus;
        if (
          !["active", "canceling", "canceled", "past_due"].includes(
            status ?? "",
          )
        )
          throw new BillingError(
            "WAFFO_SUBSCRIPTION_STATUS_INVALID",
            422,
            "Unsupported Waffo subscription state",
          );
        if (!domainStatuses[event.eventType]?.includes(status ?? ""))
          throw new BillingError(
            "WAFFO_SUBSCRIPTION_STATUS_INVALID",
            422,
            "Subscription event and state do not match",
          );
        // A canceling subscription remains paid and active through its period.
        // It can arrive before activation, so establish the order before syncing it.
        if (status === "active" || status === "canceling") {
          this.validateAmount(event, order);

          await billing.fulfillOrder({
            orderId: order.id,
            externalSubscriptionId: event.data.orderId,
            externalProductId: order.externalProductId,
            currentPeriodStart: event.data.currentPeriodStart,
            currentPeriodEnd: event.data.currentPeriodEnd,
            status: "active",
            metadata: { waffoOrderId: event.data.orderId },
          });
        }
        const fulfilled = await billing.getOrder(order.id);
        if (fulfilled?.teamId) {
          const snapshot: TeamSubscriptionSnapshot = {
            teamId: fulfilled.teamId,
            provider: "waffo",
            eventOccurredAt: event.timestamp,
            confirmCoverage: confirmsCoverage,
            planFamily: order.planFamily,
            status:
              status === "canceling"
                ? "active"
                : (status as "active" | "canceled" | "past_due"),
            billingInterval: order.billingInterval,
            currentPeriodStart: event.data.currentPeriodStart!,
            currentPeriodEnd: event.data.currentPeriodEnd!,
            externalCustomerId: null,
            externalSubscriptionId: event.data.orderId,
            externalProductId: order.externalProductId,
            billingOrderId: order.id,
            cancelAtPeriodEnd: status === "canceling",
            seatCount: order.quantity,
            metadata: {
              ...fulfilled.metadata,
              waffoOrderId: event.data.orderId,
              waffoLastEventAt: event.timestamp,
              waffoLastEventType: event.eventType,
            },
          };
          await billing.syncSubscriptionSnapshot(snapshot);
        }
        // Locked read-modify-write: an unlocked `billing.getOrder` here could
        // read the row before a concurrent reversal commits its
        // refundedAmount/reversalStatus/metadata.reversalPaidAmount, and
        // writing that stale snapshot back would erase them. Merge onto the
        // freshly locked row's metadata instead, so those keys survive.
        await updateOrderLocked(store, order.id, (locked) => ({
          metadata: {
            ...locked.metadata,
            waffoOrderId: event.data.orderId,
            waffoLastEventAt: event.timestamp,
            waffoLastEventType: event.eventType,
          },
        }));
      }
    }
    const current = await billing.getOrder(order.id);
    await store.updateWebhookEventState(receiptId, {
      status: "processed",
      processedAt: new Date().toISOString(),
      teamId: current?.teamId ?? order.teamId,
      externalSubscriptionId:
        order.kind === "subscription" ? event.data.orderId : null,
      errorCode: null,
      errorMessage: null,
    });
    this.input.logger.info("Waffo webhook processed", {
      eventId: event.id,
      eventType: event.eventType,
      orderId: order.id,
      mode: event.mode,
    });
  }
  /**
   * A refund with no local reference, or whose reference matches no local
   * order: an operator problem (a stray receipt, a migrated/deleted order),
   * not a transient one — UNLESS the event's own Waffo order id is a
   * subscription's `externalSubscriptionId`: a subscription *renewal*
   * payment has no local SourceWeft order row at all (see
   * `syncSubscriptionSnapshot`'s `externalSubscriptionId: event.data.orderId`
   * above), so that is the expected, not exceptional, shape for a refund of
   * one. Notice-and-ignore rather than throw either way, so it does not
   * retry forever. Runs before an `order` is even resolved, so only the
   * event itself is available for the notice.
   *
   * `isRefund` (the caller) covers both `refund.succeeded` and
   * `refund.failed` — a failed refund with no local reference reaches here
   * too, but nothing was actually refunded, so it must not raise either
   * notice (an error-level "Subscription payment reversed" alert for a
   * refund that never happened is worse than the noise it would save).
   * Mirrors `processRefund`'s own `refund.failed` short-circuit for the
   * known-order case, and Creem's early `status === "failed"` return, which
   * both skip notice logic entirely for a non-final/failed event.
   */
  private async unmatchedRefund(event: WebhookEvent, receiptId: string) {
    if (event.eventType === "refund.failed") {
      this.input.logger.info("Waffo refund failed upstream; ignored", {
        eventId: event.id,
        refundTicketId: event.data.refundTicketMerchantExternalId,
      });
      return this.ignore(receiptId, "WAFFO_REFUND_FAILED");
    }

    const subscription = await this.input.billing.findSubscriptionByProvider(
      "waffo",
      event.data.orderId,
    );
    if (subscription) {
      await this.input.billing.reportPaymentReversalNotice({
        reason: "subscription_payment",
        provider: "waffo",
        providerReference:
          event.data.refundTicketMerchantExternalId ?? event.eventId,
        orderId: subscription.billingOrderId,
        teamId: subscription.teamId,
        amount: parseRefundAmount(event.data.refundedAmount),
        currency: event.data.currency,
      });
      return this.ignore(receiptId, "WAFFO_REFUND_SUBSCRIPTION_PAYMENT");
    }

    await this.input.billing.reportPaymentReversalNotice({
      reason: "unmatched",
      provider: "waffo",
      providerReference:
        event.data.refundTicketMerchantExternalId ?? event.eventId,
      currency: event.data.currency,
    });
    return this.ignore(receiptId, "WAFFO_REFUND_UNMATCHED");
  }
  /**
   * Translates a Waffo refund event into the reversal core and nothing more.
   * Runs ahead of the product-key check and the stale guard: a refund on an
   * order Waffo otherwise considers stale (e.g. a canceled subscription) must
   * still be applied or noticed, not dropped. Every failure mode here ends
   * the receipt `ignored` with a notice/alert rather than `failed`: none of
   * them are transient, so retrying every 30s would only repeat them forever.
   */
  private async processRefund(
    event: WebhookEvent,
    order: BillingOrderState,
    receiptId: string,
  ) {
    const { billing, store } = this.input;
    if (event.eventType === "refund.failed") {
      this.input.logger.info("Waffo refund failed upstream; ignored", {
        eventId: event.id,
        orderId: order.id,
        refundTicketId: event.data.refundTicketMerchantExternalId,
      });
      return this.ignore(receiptId, "WAFFO_REFUND_FAILED");
    }
    const { data } = event;
    const refundedAmount = parseRefundAmount(data.refundedAmount);
    const paidAmount = parseRefundAmount(data.originalChargedAmount);
    if (refundedAmount === null || paidAmount === null) {
      await billing.reportPaymentReversalNotice({
        reason: "amount_unavailable",
        provider: "waffo",
        providerReference: data.refundTicketMerchantExternalId ?? event.eventId,
        orderId: order.id,
        teamId: order.teamId,
        currency: data.currency,
      });
      return this.ignore(receiptId, "WAFFO_REFUND_AMOUNT_UNAVAILABLE");
    }
    let result;
    try {
      result = await billing.applyPaymentReversal({
        orderId: order.id,
        provider: "waffo",
        reversalId: data.refundTicketMerchantExternalId ?? event.eventId,
        kind: "refund",
        amount: { refundAmount: refundedAmount },
        paidAmount,
        currency: data.currency,
        metadata: {
          waffoOrderId: data.orderId,
          refundStatus: data.refundStatus,
          refundReason: data.refundReason,
        },
      });
    } catch (error) {
      // The core rejects an order it cannot reverse (missing team/unit-type
      // binding) by throwing rather than returning an outcome — that shape
      // is for a caller bug, not a webhook event. Treat it the same as an
      // unmatched order rather than retrying forever.
      if (
        error instanceof BillingError &&
        error.code === "BILLING_ORDER_INVALID"
      ) {
        await billing.reportPaymentReversalNotice({
          reason: "unmatched",
          provider: "waffo",
          providerReference:
            data.refundTicketMerchantExternalId ?? event.eventId,
          orderId: order.id,
          teamId: order.teamId,
          currency: data.currency,
        });
        return this.ignore(receiptId, "WAFFO_REFUND_REJECTED");
      }
      throw error;
    }
    if (result.outcome === "rejected")
      return this.ignore(receiptId, "WAFFO_REFUND_REJECTED");
    await store.updateWebhookEventState(receiptId, {
      status: "processed",
      processedAt: new Date().toISOString(),
      teamId: order.teamId,
      externalSubscriptionId:
        order.kind === "subscription" ? data.orderId : null,
      errorCode: null,
      errorMessage: null,
    });
    this.input.logger.info("Waffo refund webhook processed", {
      eventId: event.id,
      eventType: event.eventType,
      orderId: order.id,
      outcome: result.outcome,
      mode: event.mode,
    });
  }
  private validateOrder(
    event: WebhookEvent,
    order: BillingOrderState,
    settings: WaffoSettings,
  ) {
    if (
      order.provider !== "waffo" ||
      order.metadata.waffoStoreId !== settings.storeId ||
      order.metadata.waffoEnvironment !== event.mode ||
      order.metadata.waffoMerchantId !== settings.merchantId
    )
      throw new BillingError(
        "WAFFO_ORDER_BINDING_MISMATCH",
        422,
        "Payment does not match the persisted checkout provider, merchant, store and environment",
      );
    if (event.data.currency?.toUpperCase() !== order.currency?.toUpperCase())
      throw new BillingError(
        "WAFFO_CURRENCY_MISMATCH",
        422,
        "Payment currency differs from checkout",
      );
    if (
      typeof order.metadata.waffoOrderId === "string" &&
      order.metadata.waffoOrderId !== event.data.orderId
    )
      throw new BillingError(
        "WAFFO_ORDER_MISMATCH",
        422,
        "A different Waffo order is already bound to this checkout",
      );
  }
  private validateAmount(event: WebhookEvent, order: BillingOrderState) {
    const total = displayToCents(event.data.total ?? event.data.amount);
    const tax = displayToCents(event.data.taxAmount);
    const expected = order.amountTotal;
    if (
      !expected ||
      total < expected ||
      (total !== expected && total - tax !== expected)
    )
      throw new BillingError(
        "WAFFO_AMOUNT_MISMATCH",
        422,
        "Payment amount differs from the server-calculated checkout amount",
      );
  }
}
