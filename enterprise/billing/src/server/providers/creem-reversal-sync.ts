import type { BillingLogger } from "../host";
import type {
  PaymentReversalInput,
  PaymentReversalNotice,
} from "../payment-reversal";
import { toObjectRecord } from "../records";
import type { BillingService } from "../service";
import type { BillingOrderState } from "../types";

/**
 * Translates a Creem `refund.created` / `dispute.created` event (already
 * authenticated and mode-checked by the webhook handler) into the
 * payment-reversal core's input. This module owns the Creem-specific
 * mapping; the handler only dispatches to it. Every event is recorded
 * through `processSubscriptionWebhookEvent`, so a redelivered refund or
 * dispute id is deduplicated at the webhook-receipt level rather than
 * reversing the top-up twice.
 */

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

// Creem's `subscription` reference shows up as either a bare id or an
// embedded object with its own `id`, depending on the event.
function readReferenceId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return readString(toObjectRecord(value), "id");
}

/**
 * `checkout.metadata.orderId` when the refund/dispute carries an embedded
 * checkout object; otherwise the transaction id on the top-up order
 * recorded at fulfillment (see `syncCreemCheckoutCompleted`).
 */
async function resolveOrder(
  billing: BillingService,
  data: Record<string, unknown>,
): Promise<BillingOrderState | null> {
  const checkout = toObjectRecord(data.checkout);
  const orderId = checkout
    ? readString(toObjectRecord(checkout.metadata), "orderId")
    : null;
  if (orderId) {
    return billing.getOrder(orderId);
  }

  const transactionId = readString(toObjectRecord(data.transaction), "id");
  return transactionId
    ? billing.findOrderByProviderPaymentId("creem", transactionId)
    : null;
}

export function createCreemReversalSync(deps: {
  billing: BillingService;
  logger: BillingLogger;
}) {
  const { billing, logger } = deps;

  return async function syncCreemReversalEvent(
    eventType: "refund.created" | "dispute.created",
    data: Record<string, unknown>,
  ): Promise<void> {
    const webhookId = readString(data, "webhookId");
    const externalSubscriptionId = readReferenceId(data.subscription);
    const order = await resolveOrder(billing, data);
    const reversalId = readString(data, "id") ?? webhookId ?? "unknown";

    async function record(
      paymentReversal: PaymentReversalInput | null,
      reversalNotice: PaymentReversalNotice | null,
    ) {
      await billing.processSubscriptionWebhookEvent({
        provider: "creem",
        providerEventId: webhookId,
        eventType,
        payload: data,
        teamId: order?.teamId ?? null,
        externalSubscriptionId,
        snapshot: null,
        paymentReversal,
        reversalNotice,
      });
    }

    if (eventType === "dispute.created") {
      // A dispute only ever produces a notice: balances change solely on a
      // provider's terminal "lost" decision, which Creem does not model as
      // a separate event today.
      await record(null, {
        reason: "dispute_opened",
        provider: "creem",
        providerReference: reversalId,
        orderId: order?.id ?? null,
        teamId: order?.teamId ?? null,
        amount: readNumber(data, "amount"),
        currency: readString(data, "currency"),
      });
      return;
    }

    const status = readString(data, "status");
    if (status === "failed" || status === "canceled") {
      logger.info("Creem refund did not succeed; not reversing", {
        refundId: reversalId,
        webhookId,
        status,
      });
      return;
    }

    if (status === "pending" || status === "requiresAction") {
      await record(null, {
        reason: "refund_pending",
        provider: "creem",
        providerReference: reversalId,
        orderId: order?.id ?? null,
        teamId: order?.teamId ?? null,
        amount: readNumber(data, "refund_amount"),
        currency: readString(data, "refund_currency"),
      });
      return;
    }

    // Only "succeeded" remains once failed/canceled/pending/requiresAction
    // are handled above.
    if (!order) {
      await record(null, {
        reason: "unmatched",
        provider: "creem",
        providerReference: reversalId,
        amount: readNumber(data, "refund_amount"),
        currency: readString(data, "refund_currency"),
      });
      return;
    }

    const transaction = toObjectRecord(data.transaction);
    const refundedTotal = readNumber(transaction, "refunded_amount");
    const refundAmount = readNumber(data, "refund_amount");
    const paidAmount =
      readNumber(transaction, "amount_paid") ??
      readNumber(transaction, "amount") ??
      0;
    const currency =
      readString(data, "refund_currency") ??
      readString(transaction, "currency") ??
      "";

    await record(
      {
        orderId: order.id,
        provider: "creem",
        reversalId,
        kind: "refund",
        amount:
          refundedTotal !== null
            ? { refundedTotal }
            : { refundAmount: refundAmount ?? 0 },
        paidAmount,
        currency,
      },
      null,
    );
  };
}
