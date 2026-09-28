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
 * through `processSubscriptionWebhookEvent`, which deduplicates receipts
 * by webhook id — but a provider redelivery can arrive under a *new*
 * webhook id, so webhook-receipt dedupe alone would not stop a refund
 * from reversing the top-up twice. What actually prevents that, for a
 * refund, is the payment-reversal core's own ledger key, which is keyed
 * by the refund's own id (`reversalId`) rather than the webhook id. That
 * per-refund idempotency only holds when the refund carries its own id —
 * see the `refund_id_missing` cause below, which exists for exactly the
 * case where it does not.
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

type AmountUnavailableCause =
  | "refund_id_missing"
  | "refund_amount_invalid"
  | "paid_amount_missing"
  | "currency_missing"
  | "exceeds_paid";

/**
 * Why a succeeded refund cannot be turned into a confident reversal, or
 * `null` when it can. Checked in this order: the refund's own id is
 * missing (nothing safe to key the reversal ledger on — see the module
 * docstring); its own refund amount is missing, not a number, or not
 * positive; the tax-inclusive paid amount is unusable; the currency
 * cannot be determined; or the prior total plus this refund would exceed
 * what was paid.
 */
function amountUnavailableCause(input: {
  refundId: string | null;
  refundAmount: number | null;
  paidAmount: number | null;
  currency: string | null;
  /** Raw `transaction.refunded_amount`; null when there were no prior refunds. */
  prior: number | null;
}): AmountUnavailableCause | null {
  if (input.refundId === null) {
    return "refund_id_missing";
  }
  if (input.refundAmount === null || input.refundAmount <= 0) {
    return "refund_amount_invalid";
  }
  if (input.paidAmount === null) {
    return "paid_amount_missing";
  }
  if (!input.currency) {
    return "currency_missing";
  }
  // This consistency check runs before the payment-reversal core's own
  // per-refund ledger idempotency check (keyed by reversalId). If a
  // refund that was already fully applied is redelivered later carrying a
  // transaction snapshot that, by then, includes that same refund in
  // `refunded_amount`, this can read as exceeding the paid amount even
  // though nothing would actually double-apply — the core would just
  // no-op on the duplicate ledger key. Accepted: a visible alert on a
  // provably-safe duplicate beats silently trusting a snapshot that might
  // not be safe.
  const priorTotal = input.prior ?? 0;
  if (priorTotal + input.refundAmount > input.paidAmount) {
    return "exceeds_paid";
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
    // The embedded `transaction` is a snapshot taken BEFORE the current
    // refund. Observed in Creem test mode across three `refund.created`
    // events on one untaxed $5.00 payment: refund_amount 100 with
    // transaction.refunded_amount null, then refund_amount 150 with
    // transaction.refunded_amount 100, then refund_amount 250 with
    // transaction.refunded_amount 250 — each `refunded_amount` is the
    // cumulative total of the EARLIER refunds only, excluding this one
    // (null when there were none), and in every observed event not a
    // total that already includes this event's own `refund_amount`. Every
    // refund is therefore reversed by its own amount; `refunded_amount` is
    // used only below, as a sanity check against the paid amount.
    const refundId = readString(data, "id");
    // Raw value (null when there were no prior refunds); only the
    // consistency check below resolves it to 0.
    const prior = readNumber(transaction, "refunded_amount");
    const refundAmount = readNumber(data, "refund_amount");
    // Tax-inclusive: Creem's `amount_paid` is what the customer actually
    // paid (`amount` is the pre-tax subtotal). Reversing against `amount`
    // would overstate the fraction refunded on a taxed payment, so there is
    // no fallback here — a missing `amount_paid` is unusable, not "close
    // enough". (Creem documents `amount_paid` as tax-inclusive; the
    // observed payment above had no tax, so this itself was not observed —
    // see the README's pre-live gate for a taxed-payment check.)
    const paidAmount = readNumber(transaction, "amount_paid");
    const currency =
      readString(data, "refund_currency") ??
      readString(transaction, "currency");

    // Notice-and-stop rather than let a wrong or zero-amount "applied"
    // reversal through silently (mirrors the Waffo refund translation).
    const cause = amountUnavailableCause({
      refundId,
      refundAmount,
      paidAmount,
      currency,
      prior,
    });

    if (cause) {
      logger.warn("Creem refund amount is unusable; not reversing", {
        refundId: reversalId,
        orderId: order.id,
        webhookId,
        cause,
      });
      await record(null, {
        reason: "amount_unavailable",
        provider: "creem",
        providerReference: reversalId,
        orderId: order.id,
        teamId: order.teamId,
        amount: refundAmount,
        currency,
        metadata: { cause, prior, refundAmount, paidAmount },
      });
      return;
    }

    // `cause` above already guarantees refundId is present, refundAmount
    // is a positive number, paidAmount is a number, currency is a
    // non-empty string, and prior (defaulting to 0) plus refundAmount does
    // not exceed paidAmount — hence the assertions rather than a silent
    // `?? 0` / `?? ""` default. `refundId`, not the webhookId-falling-back
    // `reversalId`, is what keys the reversal ledger (see the module
    // docstring).
    await record(
      {
        orderId: order.id,
        provider: "creem",
        reversalId: refundId as string,
        kind: "refund",
        amount: { refundAmount: refundAmount as number },
        paidAmount: paidAmount as number,
        currency: currency as string,
      },
      null,
    );
  };
}
