import type { PoolClient } from "pg";
import type { BillingAccountService } from "./account-service";
import { BillingError } from "./errors";
import type { BillingAlertSink, BillingLogger } from "./host";
import {
  appendBillingLedger,
  createOperationId,
  formatSignedLedgerDelta,
  scopeMemberLedgerKey,
} from "./ledger";
import {
  getTotalPagesBalance,
  reclaimPages,
  syncPageMirrorFields,
} from "./page-ledger";
import { getTotalCreditsBalance, reclaimCredits } from "./service-helpers";
import type { BillingStore } from "./store-port";
import type { BillingAccountState, BillingOrderState } from "./types";

/**
 * Payment reversals: a provider refund or lost chargeback against a top-up
 * order takes the reversed share of the grant back out of the buyer's own
 * member row; a reversal the core does not apply becomes an operator alert.
 * Provider adapters only translate their events into
 * {@link PaymentReversalInput} / {@link PaymentReversalNotice}.
 *
 * Lock order matches top-up fulfillment — the order row `FOR UPDATE`, then the
 * member row via `ensureAccountLocked` — so a reversal queues behind a
 * concurrent fulfillment or usage charge on that member. A reversal that
 * arrives before fulfillment is only recorded on the order; fulfillment then
 * applies it ({@link applyRecordedReversalLocked}), so a refunded order nets
 * to zero. A failing alert sink is logged and swallowed: alerts can neither
 * fail nor roll back a reversal.
 */

export type PaymentReversalKind = "refund" | "chargeback";

export type PaymentReversalInput = {
  orderId: string;
  provider: BillingOrderState["provider"];
  reversalId: string;
  kind: PaymentReversalKind;
  /** Minor units; ignored for a chargeback, which always reverses in full. */
  amount: { refundedTotal: number } | { refundAmount: number };
  /** Minor units. */
  paidAmount: number;
  currency: string;
  metadata?: Record<string, unknown>;
};

export type PaymentReversalResult =
  | { outcome: "duplicate" }
  | {
      outcome: "rejected";
      reason: "currency_mismatch" | "invalid_amount" | "provider_mismatch";
    }
  | { outcome: "subscription_notice"; order: BillingOrderState }
  | { outcome: "recorded_before_fulfillment"; order: BillingOrderState }
  | {
      outcome: "applied";
      order: BillingOrderState;
      deltaUnits: number;
      recovered: number;
      shortfall: number;
    };

export type PaymentReversalNotice = {
  reason:
    | "subscription_payment"
    | "dispute_opened"
    | "unmatched"
    | "amount_unavailable"
    | "refund_pending";
  provider: BillingOrderState["provider"];
  providerReference: string;
  orderId?: string | null;
  teamId?: string | null;
  amount?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
};

type AlertTrigger = Pick<BillingAlertSink, "trigger">;
export type AlertInput = Parameters<BillingAlertSink["trigger"]>[0];
type RejectionReason =
  "currency_mismatch" | "invalid_amount" | "provider_mismatch";

type TopupOrder = BillingOrderState & {
  teamId: string;
  unitType: NonNullable<BillingOrderState["unitType"]>;
};

/** One reversal to apply, validated, with `refundedTotal` capped at `paidAmount`. */
type ReversalRequest = {
  reversalId: string;
  kind: PaymentReversalKind;
  provider: BillingOrderState["provider"];
  refundedTotal: number;
  paidAmount: number;
  currency: string | null;
  providerMetadata?: Record<string, unknown>;
};

const ALERT_SOURCE = "billing.payment-reversal";
const FULFILLMENT_REVERSAL_ID = "fulfillment";
// Order metadata key holding the provider's paid amount from the latest
// reversal recorded before fulfillment: the basis `refundedAmount` was
// measured against, which can differ from `amountTotal` (e.g. tax).
const RECORDED_PAID_AMOUNT_KEY = "reversalPaidAmount";

const ACTIVITY_TITLES = {
  credit: {
    refund: "Credits top-up refunded",
    chargeback: "Credits top-up charged back",
  },
  page: {
    refund: "Pages top-up refunded",
    chargeback: "Pages top-up charged back",
  },
} as const;

// Subscription notices are keyed by team (else order); the rest by
// `<provider>:<providerReference>`.
const NOTICE_ALERTS: Record<
  PaymentReversalNotice["reason"],
  { key: string; level: "warn" | "error"; title: string; message: string }
> = {
  subscription_payment: {
    key: "billing:subscription-payment-reversal",
    level: "error",
    title: "Subscription payment reversed",
    message:
      "A subscription payment was refunded or charged back. Balances were not changed; review the subscription.",
  },
  dispute_opened: {
    key: "billing:dispute-opened",
    level: "warn",
    title: "Payment dispute opened",
    message:
      "A payment dispute was opened. Balances change only if the provider reports the dispute as lost; merchant-of-record providers resolve disputes themselves.",
  },
  unmatched: {
    key: "billing:payment-reversal-unmatched",
    level: "error",
    title: "Payment reversal matched no order",
    message: "A provider refund or dispute did not match any billing order.",
  },
  amount_unavailable: {
    key: "billing:payment-reversal-amount-unavailable",
    level: "error",
    title: "Payment reversal amount unavailable",
    message: "A provider refund arrived without usable amounts; not applied.",
  },
  refund_pending: {
    key: "billing:payment-reversal-refund-pending",
    level: "error",
    title: "Payment refund pending",
    message: "A provider refund is pending or needs action; not applied.",
  },
};

/**
 * The proportional-refund formula for a payment reversal: how many of the
 * units a top-up order granted should now be reversed, given the amount
 * refunded so far against what was originally paid.
 *
 * Once `refundedTotal` reaches (or, for an over-refund, exceeds) `paidAmount`
 * the target is the full grant. Otherwise it is the same fraction of the
 * grant that has been refunded, floored to a whole unit — the caller diffs
 * this against the order's `reversed_units` to get the delta still owed back.
 */
export function computeReversalTarget(input: {
  grantedUnits: number;
  refundedTotal: number;
  paidAmount: number;
}): number {
  if (input.paidAmount <= 0) {
    throw new BillingError(
      "PAYMENT_REVERSAL_INVALID_AMOUNT",
      422,
      "paidAmount must be greater than zero",
    );
  }

  if (input.refundedTotal >= input.paidAmount) {
    return input.grantedUnits;
  }

  return Math.floor(
    (input.grantedUnits * input.refundedTotal) / input.paidAmount,
  );
}

/**
 * Fulfillment hook: right after a top-up grant, applies a reversal recorded
 * on the order before fulfillment, inside the fulfillment transaction and
 * against the member row it already holds locked (reversal id `fulfillment`).
 * A `refunded` or `charged_back` order reverses the whole grant; a partial
 * refund is measured against the paid amount recorded with it, falling back
 * to `amountTotal`. Returns the order with `reversedUnits` advanced; the
 * caller persists it in its final order update. Alerts are pushed onto
 * `pendingAlerts` rather than triggered inline, so the caller — still mid
 * fulfillment transaction here — raises them only once that transaction has
 * actually committed. An order without a usable paid amount is left for an
 * operator (rejected alert) rather than failing the grant.
 */
export async function applyRecordedReversalLocked(input: {
  store: BillingStore;
  client: PoolClient;
  account: BillingAccountState;
  order: BillingOrderState;
  pendingAlerts: AlertInput[];
}): Promise<BillingOrderState> {
  if (input.order.reversalStatus === "none") {
    return input.order;
  }

  const order = requireTopupOrder(input.order);
  const kind =
    order.reversalStatus === "charged_back" ? "chargeback" : "refund";
  const paidAmount = recordedPaidAmount(order) ?? order.amountTotal ?? 0;
  const fullReversal =
    order.reversalStatus === "refunded" ||
    order.reversalStatus === "charged_back";
  const request: ReversalRequest = {
    reversalId: FULFILLMENT_REVERSAL_ID,
    kind,
    provider: order.provider,
    refundedTotal: fullReversal
      ? paidAmount
      : Math.min(order.refundedAmount, paidAmount),
    paidAmount,
    currency: order.currency,
  };
  if (paidAmount <= 0) {
    input.pendingAlerts.push(rejectedAlert(order, request, "invalid_amount"));
    return input.order;
  }
  if (await hasReversalLedger(input.store, input.client, order, request)) {
    return input.order;
  }

  const applied = await reverseGrantLocked({ ...input, order, request });
  input.pendingAlerts.push(...applied.alerts);

  return applied.order;
}

export class BillingPaymentReversalService {
  constructor(
    private readonly store: BillingStore,
    private readonly accountService: BillingAccountService,
    private readonly alerts?: AlertTrigger,
    private readonly logger?: BillingLogger,
  ) {}

  /**
   * Applies one provider refund or chargeback. A redelivered reversal id is a
   * no-op; alerts are raised only once the transaction has committed.
   */
  async applyPaymentReversal(
    input: PaymentReversalInput,
  ): Promise<PaymentReversalResult> {
    const { result, alerts } = await this.store.runInTransaction(
      async (client) => {
        const pending: AlertInput[] = [];
        const result = await this.applyLocked(input, client, pending);
        return { result, alerts: pending };
      },
    );

    for (const alert of alerts) {
      await triggerSafely(this.alerts, this.logger, alert);
    }

    return result;
  }

  /** Raises the operator alert for a reversal the core does not apply. */
  async reportNotice(notice: PaymentReversalNotice) {
    await triggerSafely(this.alerts, this.logger, noticeAlert(notice));
  }

  private async applyLocked(
    input: PaymentReversalInput,
    client: PoolClient,
    alerts: AlertInput[],
  ): Promise<PaymentReversalResult> {
    const locked = await this.store.getOrderByIdForUpdate(
      input.orderId,
      client,
    );
    if (!locked) {
      throw new BillingError(
        "BILLING_ORDER_NOT_FOUND",
        404,
        "Billing order not found",
        { orderId: input.orderId },
      );
    }

    if (locked.kind === "subscription") {
      alerts.push(
        noticeAlert({
          reason: "subscription_payment",
          provider: input.provider,
          providerReference: input.reversalId,
          orderId: locked.id,
          teamId: locked.teamId,
          amount: eventAmount(input),
          currency: input.currency,
          metadata: {
            ...input.metadata,
            kind: input.kind,
            paidAmount: input.paidAmount,
          },
        }),
      );
      return { outcome: "subscription_notice", order: locked };
    }

    const order = requireTopupOrder(locked);
    const request: ReversalRequest = {
      reversalId: input.reversalId,
      kind: input.kind,
      provider: input.provider,
      refundedTotal: Math.min(
        nextRefundedTotal(order, input),
        input.paidAmount,
      ),
      paidAmount: input.paidAmount,
      currency: input.currency,
      providerMetadata: input.metadata,
    };
    if (await hasReversalLedger(this.store, client, order, request)) {
      return { outcome: "duplicate" };
    }

    const rejection = rejectionReason(order, input);
    if (rejection) {
      alerts.push(
        rejectedAlert(order, request, rejection, {
          amount: eventAmount(input),
        }),
      );
      return { outcome: "rejected", reason: rejection };
    }

    const orderChanges = {
      // A cumulative dispute or refund amount can be smaller than a total
      // already recorded (e.g. a chargeback's own paid amount, reported
      // independently of prior refunds); the recorded total never moves
      // backwards, for every reversal kind.
      refundedAmount: Math.max(order.refundedAmount, request.refundedTotal),
      reversalStatus: nextReversalStatus(request, order.reversalStatus),
      updatedAt: new Date().toISOString(),
    };
    const account = await this.accountService.ensureAccountLocked(
      order.teamId,
      order.userId,
      client,
    );

    if (order.status !== "fulfilled") {
      // Nothing is granted yet, so nothing moves: record the refund on the
      // order and claim the idempotency key; fulfillment reverses it.
      await appendReversalLedger({
        store: this.store,
        client,
        account,
        order,
        request,
        recovered: 0,
        details: {
          targetUnits: targetUnits(order, request),
          deltaUnits: 0,
          fromAddOn: 0,
          fromMonthly: 0,
          shortfall: 0,
          recordedBeforeFulfillment: true,
        },
      });
      alerts.push(
        orderAlert(order, request, {
          key: "billing:payment-reversal",
          level: "warn",
          title: "Top-up payment reversal recorded",
          message: `A ${request.kind} on top-up order ${order.id} was recorded before fulfillment; fulfillment will reverse it.`,
          metadata: { recordedBeforeFulfillment: true },
        }),
      );
      return {
        outcome: "recorded_before_fulfillment",
        order: await this.store.updateOrder(
          {
            ...locked,
            ...orderChanges,
            metadata: {
              ...locked.metadata,
              [RECORDED_PAID_AMOUNT_KEY]: request.paidAmount,
            },
          },
          client,
        ),
      };
    }

    const applied = await reverseGrantLocked({
      store: this.store,
      client,
      account,
      order,
      request,
    });
    alerts.push(...applied.alerts);
    return {
      outcome: "applied",
      order: await this.store.updateOrder(
        { ...applied.order, ...orderChanges },
        client,
      ),
      deltaUnits: applied.deltaUnits,
      recovered: applied.recovered,
      shortfall: applied.shortfall,
    };
  }
}

/**
 * Takes back the units the request's refunded total now entitles us to —
 * add-on first, then monthly, clamped at zero — and writes the ledger row.
 * `reversedUnits` only grows, so no later event can re-debit units already
 * reversed. Returns the order with `reversedUnits` advanced (not persisted)
 * and the alerts to raise.
 */
async function reverseGrantLocked(input: {
  store: BillingStore;
  client: PoolClient;
  account: BillingAccountState;
  order: TopupOrder;
  request: ReversalRequest;
}) {
  const { account, order, request } = input;
  const target = targetUnits(order, request);
  const deltaUnits = Math.max(target - order.reversedUnits, 0);
  const reclaimed =
    order.unitType === "credit"
      ? reclaimCredits(account, deltaUnits)
      : reclaimPages(account, deltaUnits);
  if (order.unitType === "page") {
    syncPageMirrorFields(account);
  }
  const recovered = reclaimed.fromAddOn + reclaimed.fromMonthly;
  const shortfall = deltaUnits - recovered;

  account.updatedAt = new Date().toISOString();
  await input.store.updateAccount(account, input.client);
  await appendReversalLedger({
    ...input,
    recovered,
    details: { targetUnits: target, deltaUnits, ...reclaimed, shortfall },
  });

  const outcome = { deltaUnits, recovered, shortfall };
  // A no-op reversal (nothing left to take back, e.g. a redelivered or
  // already-superseded event) still claims its ledger idempotency key below,
  // but is not worth an operator's attention.
  const alerts: AlertInput[] =
    deltaUnits > 0
      ? [
          orderAlert(order, request, {
            key: "billing:payment-reversal",
            level: "warn",
            title: "Top-up payment reversed",
            message: `A ${request.kind} reversed ${recovered} of ${deltaUnits} ${order.unitType} units on top-up order ${order.id}.`,
            metadata: outcome,
          }),
        ]
      : [];
  if (shortfall > 0) {
    alerts.push(
      orderAlert(order, request, {
        key: "billing:payment-reversal-shortfall",
        level: "error",
        title: "Payment reversal shortfall",
        message: `${shortfall} ${order.unitType} units of top-up order ${order.id} were already spent and could not be recovered.`,
        metadata: { ...outcome, userId: order.userId },
      }),
    );
  }

  return {
    order: { ...order, reversedUnits: order.reversedUnits + deltaUnits },
    ...outcome,
    alerts,
  };
}

async function appendReversalLedger(input: {
  store: BillingStore;
  client: PoolClient;
  account: BillingAccountState;
  order: TopupOrder;
  request: ReversalRequest;
  recovered: number;
  details: Record<string, unknown>;
}) {
  const { account, order, request, recovered } = input;
  // `-0` would leak into the row and its summary when nothing was recovered.
  const delta = recovered > 0 ? -recovered : 0;

  await appendBillingLedger({
    store: input.store,
    client: input.client,
    account,
    entry: {
      eventType: "adjust",
      unitType: order.unitType,
      delta,
      balanceAfter:
        order.unitType === "credit"
          ? getTotalCreditsBalance(account)
          : getTotalPagesBalance(account),
      feature:
        request.kind === "chargeback" ? "payment_chargeback" : "payment_refund",
      actorUserId: order.userId,
      referenceId: order.id,
      idempotencyKey: reversalKey(order, request),
      operationId: createOperationId(
        "payment-reversal",
        order.teamId,
        order.id,
        request.reversalId,
      ),
      operationType: "payment_reversal",
      activityVisible: recovered > 0,
      activityTitle: ACTIVITY_TITLES[order.unitType][request.kind],
      activitySummary: formatSignedLedgerDelta(order.unitType, delta),
      metadata: {
        ...requestMetadata(order, request),
        ...input.details,
        ...(request.providerMetadata
          ? { providerMetadata: request.providerMetadata }
          : {}),
      },
    },
  });
}

function reversalKey(order: TopupOrder, request: ReversalRequest) {
  return `billing-order:${order.id}:reversal:${request.reversalId}`;
}

async function hasReversalLedger(
  store: BillingStore,
  client: PoolClient,
  order: TopupOrder,
  request: ReversalRequest,
) {
  const existing = await store.getLedgerByIdempotency(
    order.teamId,
    scopeMemberLedgerKey(order.userId, reversalKey(order, request)),
    client,
  );
  return existing !== null;
}

function requireTopupOrder(order: BillingOrderState): TopupOrder {
  if (!order.teamId || !order.unitType) {
    throw new BillingError(
      "BILLING_ORDER_INVALID",
      422,
      "Top-up order is missing required metadata",
      { orderId: order.id },
    );
  }

  return { ...order, teamId: order.teamId, unitType: order.unitType };
}

function targetUnits(order: TopupOrder, request: ReversalRequest) {
  return computeReversalTarget({
    grantedUnits:
      order.unitType === "credit" ? order.grantedCredits : order.grantedPages,
    refundedTotal: request.refundedTotal,
    paidAmount: request.paidAmount,
  });
}

/** The paid amount recorded with a pre-fulfillment reversal, when usable. */
function recordedPaidAmount(order: BillingOrderState) {
  const value = order.metadata[RECORDED_PAID_AMOUNT_KEY];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/** The amount the provider reported for this event, before capping. */
function eventAmount(input: PaymentReversalInput) {
  if (input.kind === "chargeback") {
    return input.paidAmount;
  }

  return "refundedTotal" in input.amount
    ? input.amount.refundedTotal
    : input.amount.refundAmount;
}

/**
 * A cumulative total never moves the recorded total backwards (a cancelled
 * refund does not re-grant); a per-refund amount adds to it. Uncapped.
 */
function nextRefundedTotal(order: TopupOrder, input: PaymentReversalInput) {
  if (input.kind === "chargeback") {
    return input.paidAmount;
  }

  return "refundedTotal" in input.amount
    ? Math.max(order.refundedAmount, input.amount.refundedTotal)
    : order.refundedAmount + input.amount.refundAmount;
}

/** `charged_back` is terminal: a later refund cannot downgrade it. */
function nextReversalStatus(
  request: ReversalRequest,
  current: BillingOrderState["reversalStatus"],
): BillingOrderState["reversalStatus"] {
  if (current === "charged_back" || request.kind === "chargeback") {
    return "charged_back";
  }
  if (request.refundedTotal >= request.paidAmount) {
    return "refunded";
  }
  if (request.refundedTotal > 0) {
    return "partially_refunded";
  }

  return current;
}

/** A currency is only usable as a non-empty, non-blank string. */
function hasUsableCurrency(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function rejectionReason(
  order: TopupOrder,
  input: PaymentReversalInput,
): RejectionReason | null {
  if (order.provider !== input.provider) {
    return "provider_mismatch";
  }

  if (
    !hasUsableCurrency(order.currency) ||
    !hasUsableCurrency(input.currency) ||
    order.currency.toUpperCase() !== input.currency.toUpperCase()
  ) {
    return "currency_mismatch";
  }

  const amount = eventAmount(input);
  if (
    !Number.isSafeInteger(input.paidAmount) ||
    input.paidAmount <= 0 ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    return "invalid_amount";
  }

  return null;
}

function requestMetadata(order: TopupOrder, request: ReversalRequest) {
  return {
    orderId: order.id,
    reversalId: request.reversalId,
    kind: request.kind,
    provider: request.provider,
    refundedTotal: request.refundedTotal,
    paidAmount: request.paidAmount,
    currency: request.currency,
  };
}

function orderAlert(
  order: TopupOrder,
  request: ReversalRequest,
  alert: {
    key: string;
    level: "warn" | "error";
    title: string;
    message: string;
    metadata: Record<string, unknown>;
  },
): AlertInput {
  return {
    alertKey: `${alert.key}:${order.id}`,
    level: alert.level,
    source: ALERT_SOURCE,
    title: alert.title,
    message: alert.message,
    teamId: order.teamId,
    metadata: {
      ...requestMetadata(order, request),
      unitType: order.unitType,
      ...alert.metadata,
    },
  };
}

function rejectedAlert(
  order: TopupOrder,
  request: ReversalRequest,
  reason: RejectionReason,
  metadata: Record<string, unknown> = {},
) {
  return orderAlert(order, request, {
    key: "billing:payment-reversal-rejected",
    level: "error",
    title: "Payment reversal rejected",
    message:
      reason === "currency_mismatch"
        ? !hasUsableCurrency(request.currency) ||
          !hasUsableCurrency(order.currency)
          ? `Reversal ${request.reversalId} on order ${order.id} was not applied: currency missing.`
          : `Reversal ${request.reversalId} on order ${order.id} was not applied: currency ${request.currency} does not match the order currency ${order.currency}.`
        : reason === "provider_mismatch"
          ? `Reversal ${request.reversalId} on order ${order.id} was not applied: provider ${request.provider} does not match the order's provider ${order.provider}.`
          : `Reversal ${request.reversalId} on order ${order.id} was not applied: the paid or refunded amount is invalid.`,
    metadata: {
      ...metadata,
      reason,
      orderProvider: order.provider,
      orderCurrency: order.currency,
      orderAmountTotal: order.amountTotal,
      orderRefundedAmount: order.refundedAmount,
    },
  });
}

function noticeAlert(notice: PaymentReversalNotice): AlertInput {
  const rule = NOTICE_ALERTS[notice.reason];
  const subject =
    notice.reason === "subscription_payment"
      ? (notice.teamId ?? notice.orderId ?? notice.providerReference)
      : `${notice.provider}:${notice.providerReference}`;

  return {
    alertKey: `${rule.key}:${subject}`,
    level: rule.level,
    source: ALERT_SOURCE,
    title: rule.title,
    message: rule.message,
    teamId: notice.teamId ?? null,
    metadata: {
      ...notice.metadata,
      reason: notice.reason,
      provider: notice.provider,
      providerReference: notice.providerReference,
      orderId: notice.orderId ?? null,
      amount: notice.amount ?? null,
      currency: notice.currency ?? null,
    },
  };
}

export async function triggerSafely(
  alerts: AlertTrigger | undefined,
  logger: BillingLogger | undefined,
  alert: AlertInput,
) {
  try {
    await alerts?.trigger(alert);
  } catch (error) {
    logger?.error("Payment reversal alert could not be raised", {
      alertKey: alert.alertKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
