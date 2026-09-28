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

// Creem's `subscription`/`order` references show up as either a bare id or
// an embedded object with its own `id`, depending on the event.
function readReferenceId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return readString(toObjectRecord(value), "id");
}

/**
 * `checkout.metadata.orderId` when the refund/dispute carries an embedded
 * checkout object; otherwise the local order may be stored under the
 * transaction id or under the Creem order id, depending on whether the
 * original checkout's payment carried a `transaction` field (see
 * `syncCreemCheckoutCompleted`, which falls back to the payment's own `id`
 * when it did not). Try every order reference the refund/dispute itself
 * carries, in order, until one resolves.
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

  const transaction = toObjectRecord(data.transaction);
  const candidates = [
    readReferenceId(data.transaction),
    readReferenceId(data.order),
    readString(transaction, "order"),
  ];

  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) {
      continue;
    }
    tried.add(candidate);
    const found = await billing.findOrderByProviderPaymentId(
      "creem",
      candidate,
    );
    if (found) {
      return found;
    }
  }

  return null;
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
      logger.warn("Creem dispute opened", {
        disputeId: reversalId,
        orderId: order?.id ?? null,
        webhookId,
      });
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

    if (status !== "succeeded") {
      // Anything that isn't a terminal success or failure — "pending",
      // "requiresAction", an unrecognized value, or a missing status
      // entirely — is not final yet. Treat it the same way and carry the
      // raw status along so an operator can tell them apart.
      logger.warn("Creem refund is not final; reporting a pending notice", {
        refundId: reversalId,
        orderId: order?.id ?? null,
        webhookId,
        status,
      });
      await record(null, {
        reason: "refund_pending",
        provider: "creem",
        providerReference: reversalId,
        orderId: order?.id ?? null,
        teamId: order?.teamId ?? null,
        amount: readNumber(data, "refund_amount"),
        currency: readString(data, "refund_currency"),
        metadata: { status },
      });
      return;
    }

    if (!order) {
      logger.warn("Creem refund matched no local order", {
        refundId: reversalId,
        orderId: null,
        webhookId,
      });
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
    // Tax-inclusive: Creem's `amount_paid` is what the customer actually
    // paid (`amount` is the pre-tax subtotal). Reversing against `amount`
    // would overstate the fraction refunded on a taxed payment, so there is
    // no fallback here — a missing `amount_paid` is unusable, not "close
    // enough".
    const paidAmount = readNumber(transaction, "amount_paid");
    const currency =
      readString(data, "refund_currency") ?? readString(transaction, "currency");

    // Nothing here can be turned into a confident reversal when: neither a
    // usable cumulative total nor a usable per-refund amount exists; the
    // tax-inclusive paid amount is unusable; the cumulative total is stale
    // (less than this event's own refund amount, which would otherwise
    // under-reverse and look like a legitimate small refund); or the
    // currency cannot be determined at all. Notice-and-stop in every case
    // rather than let a wrong or zero-amount "applied" reversal through
    // silently (mirrors the Waffo refund translation).
    const amountUnavailable =
      (refundedTotal === null && refundAmount === null) ||
      paidAmount === null ||
      !currency ||
      (refundedTotal !== null &&
        refundAmount !== null &&
        refundedTotal < refundAmount);

    if (amountUnavailable) {
      logger.warn("Creem refund amount is unusable; not reversing", {
        refundId: reversalId,
        orderId: order.id,
        webhookId,
      });
      await record(null, {
        reason: "amount_unavailable",
        provider: "creem",
        providerReference: reversalId,
        orderId: order.id,
        teamId: order.teamId,
        amount: refundedTotal ?? refundAmount,
        currency,
      });
      return;
    }

    // `amountUnavailable` above already guarantees: at least one of
    // refundedTotal/refundAmount is a number, paidAmount is a number, and
    // currency is a non-empty string — hence the assertions rather than a
    // silent `?? 0` / `?? ""` default.
    await record(
      {
        orderId: order.id,
        provider: "creem",
        reversalId,
        kind: "refund",
        amount:
          refundedTotal !== null
            ? { refundedTotal }
            : { refundAmount: refundAmount as number },
        paidAmount: paidAmount as number,
        currency: currency as string,
      },
      null,
    );
  };
}
