import assert from "node:assert/strict";
import { test } from "vitest";
import { BillingAccountService } from "../src/server/account-service";
import type { BillingAlertSink } from "../src/server/host";
import {
  BillingPaymentReversalService,
  computeReversalTarget,
  type PaymentReversalInput,
  type PaymentReversalNotice,
} from "../src/server/payment-reversal";
import { reclaimCredits } from "../src/server/service-helpers";
import { reclaimPages } from "../src/server/page-ledger";
import { BillingService } from "../src/server/service";
import type { BillingOrderState } from "../src/server/types";
import {
  assertRejectsWithBillingCode,
  createActiveTeamAccount,
  MemoryBillingStore,
  noopProvider,
  runtimeConfig,
} from "./test-fixtures";

// Pure math and balance-reclaim primitives the payment-reversal service
// builds on: how many granted units a refund reverses, and how those units
// come back out of a member's own balance.

test("computeReversalTarget is proportional to the refunded fraction, floored", () => {
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 500,
      paidAmount: 1000,
    }),
    10_000,
  );
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 333,
      paidAmount: 1000,
    }),
    6_660,
  );
});

test("computeReversalTarget reverses the full grant once the refunded total reaches the paid amount", () => {
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 1000,
      paidAmount: 1000,
    }),
    20_000,
  );
});

test("computeReversalTarget caps at the full grant for an over-refund", () => {
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 1500,
      paidAmount: 1000,
    }),
    20_000,
  );
});

test("computeReversalTarget is zero when nothing has been refunded", () => {
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 0,
      paidAmount: 1000,
    }),
    0,
  );
});

test("computeReversalTarget rejects a non-positive paid amount", () => {
  assert.throws(
    () =>
      computeReversalTarget({
        grantedUnits: 20_000,
        refundedTotal: 0,
        paidAmount: 0,
      }),
    { code: "PAYMENT_REVERSAL_INVALID_AMOUNT" },
  );
});

test("reclaimCredits takes from add-on first, then monthly, clamped at the balances", () => {
  const account = createActiveTeamAccount({
    addOnCreditsBalance: 300,
    monthlyCreditsBalance: 500,
  });

  const reclaimed = reclaimCredits(account, 600);

  assert.deepEqual(reclaimed, { fromAddOn: 300, fromMonthly: 300 });
  assert.equal(account.addOnCreditsBalance, 0);
  assert.equal(account.monthlyCreditsBalance, 200);
});

test("reclaimCredits stops at zero when the reclaim exceeds both balances", () => {
  const account = createActiveTeamAccount({
    addOnCreditsBalance: 300,
    monthlyCreditsBalance: 500,
  });

  const reclaimed = reclaimCredits(account, 2000);

  assert.deepEqual(reclaimed, { fromAddOn: 300, fromMonthly: 500 });
  assert.equal(account.addOnCreditsBalance, 0);
  assert.equal(account.monthlyCreditsBalance, 0);
});

test("reclaimPages takes from add-on first, then monthly, clamped at the balances", () => {
  const account = createActiveTeamAccount({
    addOnPagesBalance: 300,
    monthlyPagesBalance: 500,
  });

  const reclaimed = reclaimPages(account, 600);

  assert.deepEqual(reclaimed, { fromAddOn: 300, fromMonthly: 300 });
  assert.equal(account.addOnPagesBalance, 0);
  assert.equal(account.monthlyPagesBalance, 200);
});

test("reclaimPages stops at zero when the reclaim exceeds both balances", () => {
  const account = createActiveTeamAccount({
    addOnPagesBalance: 300,
    monthlyPagesBalance: 500,
  });

  const reclaimed = reclaimPages(account, 2000);

  assert.deepEqual(reclaimed, { fromAddOn: 300, fromMonthly: 500 });
  assert.equal(account.addOnPagesBalance, 0);
  assert.equal(account.monthlyPagesBalance, 0);
});

test("reclaimCredits is a no-op for zero or negative units and never inflates a balance", () => {
  const zero = createActiveTeamAccount({
    addOnCreditsBalance: 300,
    monthlyCreditsBalance: 500,
  });
  assert.deepEqual(reclaimCredits(zero, 0), { fromAddOn: 0, fromMonthly: 0 });
  assert.equal(zero.addOnCreditsBalance, 300);
  assert.equal(zero.monthlyCreditsBalance, 500);

  const negative = createActiveTeamAccount({
    addOnCreditsBalance: 300,
    monthlyCreditsBalance: 500,
  });
  assert.deepEqual(reclaimCredits(negative, -100), {
    fromAddOn: 0,
    fromMonthly: 0,
  });
  assert.equal(negative.addOnCreditsBalance, 300);
  assert.equal(negative.monthlyCreditsBalance, 500);
});

test("reclaimPages is a no-op for zero or negative units and never inflates a balance", () => {
  const zero = createActiveTeamAccount({
    addOnPagesBalance: 300,
    monthlyPagesBalance: 500,
  });
  assert.deepEqual(reclaimPages(zero, 0), { fromAddOn: 0, fromMonthly: 0 });
  assert.equal(zero.addOnPagesBalance, 300);
  assert.equal(zero.monthlyPagesBalance, 500);

  const negative = createActiveTeamAccount({
    addOnPagesBalance: 300,
    monthlyPagesBalance: 500,
  });
  assert.deepEqual(reclaimPages(negative, -100), {
    fromAddOn: 0,
    fromMonthly: 0,
  });
  assert.equal(negative.addOnPagesBalance, 300);
  assert.equal(negative.monthlyPagesBalance, 500);
});

// The reversal service end to end on the in-memory store: a provider refund or
// chargeback against a top-up order moves the buyer's balance, the order's
// reversal state and the ledger, and raises the documented alerts. The
// in-memory store never rolls back, so nothing here relies on a transaction
// undoing a write; PostgreSQL behaviour is covered by the database tests.

type RecordedAlert = Parameters<BillingAlertSink["trigger"]>[0];

function createTopupOrder(
  overrides: Partial<BillingOrderState> = {},
): BillingOrderState {
  const now = new Date().toISOString();

  return {
    id: "order_1",
    provider: "waffo",
    kind: "credit_topup",
    status: "payment_confirmed",
    paymentStatus: "paid",
    userId: "user_1",
    teamId: "team_1",
    clientReferenceKey: null,
    planFamily: null,
    billingInterval: null,
    quantity: 2,
    unitType: "credit",
    unitAmount: 10_000,
    grantedCredits: 20_000,
    grantedPages: 0,
    refundedAmount: 0,
    reversedUnits: 0,
    reversalStatus: "none",
    externalCheckoutId: "checkout_1",
    externalPaymentId: "pay_1",
    externalCustomerId: null,
    externalSubscriptionId: null,
    externalProductId: "prod_credit_topup",
    amountTotal: 1000,
    currency: "USD",
    successUrl: null,
    cancelUrl: null,
    metadata: {},
    errorCode: null,
    errorMessage: null,
    paidAt: now,
    fulfilledAt: null,
    expiresAt: null,
    fulfillmentAttemptCount: 0,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * A member with 40,000 monthly credits and an empty add-on bucket, holding
 * one top-up order. Unless `fulfilled: false`, the order is fulfilled through
 * the real fulfillment path first, so a 20,000-credit top-up lands in add-on.
 */
async function setupTopup(
  options: {
    order?: Partial<BillingOrderState>;
    fulfilled?: boolean;
    alerts?: BillingAlertSink;
    store?: MemoryBillingStore;
  } = {},
) {
  const store = options.store ?? new MemoryBillingStore();
  const alerts: RecordedAlert[] = [];
  const service = new BillingService(
    store,
    runtimeConfig,
    noopProvider,
    options.alerts ?? {
      async trigger(input) {
        alerts.push(input);
      },
      async resolve() {},
    },
  );
  store.account = createActiveTeamAccount({ userId: "user_1" });
  store.order = createTopupOrder(options.order);

  if (options.fulfilled !== false) {
    await service.fulfillOrder({ orderId: "order_1" });
  }

  return { store, alerts, service };
}

function reversal(
  overrides: Partial<PaymentReversalInput> = {},
): PaymentReversalInput {
  return {
    orderId: "order_1",
    provider: "waffo",
    reversalId: "refund_1",
    kind: "refund",
    amount: { refundAmount: 1000 },
    paidAmount: 1000,
    currency: "USD",
    ...overrides,
  };
}

function reversalRows(store: MemoryBillingStore) {
  return store.ledgers.filter(
    (entry) => entry.operationType === "payment_reversal",
  );
}

function alertLevels(alerts: RecordedAlert[]) {
  return alerts.map((alert) => [alert.alertKey, alert.level]);
}

test("full refund reverses the whole top-up from add-on", async () => {
  const { store, alerts, service } = await setupTopup();
  assert.equal(store.account?.addOnCreditsBalance, 20_000);

  const result = await service.applyPaymentReversal(reversal());

  assert.equal(result.outcome, "applied");
  assert.equal(store.account?.addOnCreditsBalance, 0);
  assert.equal(store.account?.monthlyCreditsBalance, 40_000);

  const rows = reversalRows(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.delta, -20_000);
  assert.equal(rows[0]?.balanceAfter, 40_000);
  assert.equal(rows[0]?.eventType, "adjust");
  assert.equal(rows[0]?.unitType, "credit");
  assert.equal(rows[0]?.feature, "payment_refund");
  assert.equal(rows[0]?.referenceId, "order_1");
  assert.equal(
    rows[0]?.idempotencyKey,
    "user_1:billing-order:order_1:reversal:refund_1",
  );
  assert.equal(rows[0]?.activityVisible, true);
  assert.equal(rows[0]?.activityTitle, "Credits top-up refunded");
  assert.equal(rows[0]?.activitySummary, "-20,000 credits");
  assert.deepEqual(rows[0]?.metadata, {
    orderId: "order_1",
    reversalId: "refund_1",
    kind: "refund",
    provider: "waffo",
    refundedTotal: 1000,
    paidAmount: 1000,
    currency: "USD",
    targetUnits: 20_000,
    deltaUnits: 20_000,
    fromAddOn: 20_000,
    fromMonthly: 0,
    shortfall: 0,
  });

  assert.equal(store.order?.reversalStatus, "refunded");
  assert.equal(store.order?.reversedUnits, 20_000);
  assert.equal(store.order?.refundedAmount, 1000);
  assert.equal(store.order?.status, "fulfilled");

  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal:order_1", "warn"],
  ]);
  assert.equal(alerts[0]?.source, "billing.payment-reversal");
  assert.equal(alerts[0]?.teamId, "team_1");
});

test("partial refunds accumulate and never exceed the grant", async () => {
  const { store, service } = await setupTopup();

  const steps: Array<[string, number, number, string]> = [
    ["r1", 8_000, 12_000, "partially_refunded"],
    ["r2", 16_000, 4_000, "partially_refunded"],
    ["r3", 20_000, 0, "refunded"],
  ];
  for (const [reversalId, reversedUnits, addOn, status] of steps) {
    await service.applyPaymentReversal(
      reversal({ reversalId, amount: { refundAmount: 400 } }),
    );
    assert.equal(store.order?.reversedUnits, reversedUnits);
    assert.equal(store.account?.addOnCreditsBalance, addOn);
    assert.equal(store.order?.reversalStatus, status);
  }

  assert.deepEqual(
    reversalRows(store).map((row) => row.delta),
    [-8_000, -8_000, -4_000],
  );
  assert.equal(store.order?.refundedAmount, 1000);
});

test("cumulative totals are idempotent and never go backwards", async () => {
  const { store, alerts, service } = await setupTopup();

  const first = await service.applyPaymentReversal(
    reversal({ reversalId: "k500", amount: { refundedTotal: 500 } }),
  );
  assert.equal(first.outcome, "applied");
  assert.equal(store.account?.addOnCreditsBalance, 10_000);
  const alertsAfterFirst = alerts.length;

  const replay = await service.applyPaymentReversal(
    reversal({ reversalId: "k500", amount: { refundedTotal: 500 } }),
  );
  assert.deepEqual(replay, { outcome: "duplicate" });
  assert.equal(store.account?.addOnCreditsBalance, 10_000);
  assert.equal(alerts.length, alertsAfterFirst);

  const lower = await service.applyPaymentReversal(
    reversal({ reversalId: "k300", amount: { refundedTotal: 300 } }),
  );
  assert.ok(lower.outcome === "applied");
  assert.equal(lower.deltaUnits, 0);
  assert.equal(store.account?.addOnCreditsBalance, 10_000);
  assert.equal(store.order?.refundedAmount, 500);
  assert.equal(store.order?.reversedUnits, 10_000);
  assert.deepEqual(
    reversalRows(store).map((row) => [row.delta, row.activityVisible]),
    [
      [-10_000, true],
      [0, false],
    ],
  );
});

test("spent credits leave a recorded shortfall without failing", async () => {
  const { store, alerts, service } = await setupTopup();
  store.account!.addOnCreditsBalance = 0;
  store.account!.monthlyCreditsBalance = 5_000;

  const result = await service.applyPaymentReversal(reversal());

  assert.ok(result.outcome === "applied");
  assert.equal(result.deltaUnits, 20_000);
  assert.equal(result.recovered, 5_000);
  assert.equal(result.shortfall, 15_000);
  assert.equal(store.account?.addOnCreditsBalance, 0);
  assert.equal(store.account?.monthlyCreditsBalance, 0);

  const [row] = reversalRows(store);
  assert.equal(row?.delta, -5_000);
  assert.equal(row?.balanceAfter, 0);
  assert.equal(row?.metadata.fromAddOn, 0);
  assert.equal(row?.metadata.fromMonthly, 5_000);
  assert.equal(row?.metadata.shortfall, 15_000);
  assert.equal(store.order?.reversedUnits, 20_000);

  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal:order_1", "warn"],
    ["billing:payment-reversal-shortfall:order_1", "error"],
  ]);
});

test("provider currency casing is ignored", async () => {
  const { store, service } = await setupTopup();

  const result = await service.applyPaymentReversal(
    reversal({ currency: "usd" }),
  );

  assert.equal(result.outcome, "applied");
  assert.equal(store.account?.addOnCreditsBalance, 0);
});

test("currency mismatch is rejected with an alert", async () => {
  const { store, alerts, service } = await setupTopup();

  const result = await service.applyPaymentReversal(
    reversal({ currency: "EUR" }),
  );

  assert.deepEqual(result, {
    outcome: "rejected",
    reason: "currency_mismatch",
  });
  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.equal(reversalRows(store).length, 0);
  assert.equal(store.order?.refundedAmount, 0);
  assert.equal(store.order?.reversalStatus, "none");
  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal-rejected:order_1", "error"],
  ]);
  assert.equal(alerts[0]?.source, "billing.payment-reversal");
});

test("provider mismatch is rejected with an alert", async () => {
  const { store, alerts, service } = await setupTopup();

  const result = await service.applyPaymentReversal(
    reversal({ provider: "creem" }),
  );

  assert.deepEqual(result, {
    outcome: "rejected",
    reason: "provider_mismatch",
  });
  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.equal(reversalRows(store).length, 0);
  assert.equal(store.order?.refundedAmount, 0);
  assert.equal(store.order?.reversalStatus, "none");
  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal-rejected:order_1", "error"],
  ]);
  assert.equal(alerts[0]?.source, "billing.payment-reversal");
});

test("an order without a currency is rejected as a currency mismatch", async () => {
  const { store, alerts, service } = await setupTopup({
    order: { currency: null },
  });

  const result = await service.applyPaymentReversal(reversal());

  assert.deepEqual(result, {
    outcome: "rejected",
    reason: "currency_mismatch",
  });
  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal-rejected:order_1", "error"],
  ]);
});

test("a missing currency is rejected, not thrown", async () => {
  const { store, alerts, service } = await setupTopup();

  const result = await service.applyPaymentReversal(
    reversal({ currency: undefined as unknown as string }),
  );

  assert.deepEqual(result, {
    outcome: "rejected",
    reason: "currency_mismatch",
  });
  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.equal(reversalRows(store).length, 0);
  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal-rejected:order_1", "error"],
  ]);
  assert.match(alerts[0]?.message ?? "", /currency missing/);
});

test("invalid amounts are rejected with an alert", async () => {
  const { store, alerts, service } = await setupTopup();

  assert.deepEqual(
    await service.applyPaymentReversal(reversal({ paidAmount: 0 })),
    { outcome: "rejected", reason: "invalid_amount" },
  );
  assert.deepEqual(
    await service.applyPaymentReversal(
      reversal({ amount: { refundAmount: -100 } }),
    ),
    { outcome: "rejected", reason: "invalid_amount" },
  );

  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.equal(reversalRows(store).length, 0);
  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal-rejected:order_1", "error"],
    ["billing:payment-reversal-rejected:order_1", "error"],
  ]);
});

test("an unknown order is a caller error", async () => {
  const { store, service } = await setupTopup();
  store.order = null;

  await assertRejectsWithBillingCode(
    () => service.applyPaymentReversal(reversal()),
    "BILLING_ORDER_NOT_FOUND",
  );
});

test("page top-ups reverse from page buckets", async () => {
  const { store, service } = await setupTopup({
    order: {
      kind: "page_topup",
      unitType: "page",
      quantity: 1,
      unitAmount: 1_000,
      grantedCredits: 0,
      grantedPages: 1_000,
      externalProductId: "prod_page_topup",
    },
  });
  assert.equal(store.account?.addOnPagesBalance, 1_000);

  await service.applyPaymentReversal(reversal());

  assert.equal(store.account?.addOnPagesBalance, 0);
  assert.equal(store.account?.monthlyPagesBalance, 12_000);
  assert.equal(store.account?.addOnCreditsBalance, 0);
  const [row] = reversalRows(store);
  assert.equal(row?.unitType, "page");
  assert.equal(row?.delta, -1_000);
  assert.equal(row?.activityTitle, "Pages top-up refunded");
  assert.equal(store.order?.reversedUnits, 1_000);
});

test("chargeback reverses in full", async () => {
  const { store, service } = await setupTopup();

  const result = await service.applyPaymentReversal(
    reversal({
      reversalId: "dispute_1",
      kind: "chargeback",
      amount: { refundedTotal: 0 },
    }),
  );

  assert.equal(result.outcome, "applied");
  assert.equal(store.account?.addOnCreditsBalance, 0);
  assert.equal(store.order?.reversalStatus, "charged_back");
  assert.equal(store.order?.refundedAmount, 1000);
  assert.equal(store.order?.reversedUnits, 20_000);
  const [row] = reversalRows(store);
  assert.equal(row?.feature, "payment_chargeback");
  assert.equal(row?.activityTitle, "Credits top-up charged back");
  assert.equal(row?.metadata.kind, "chargeback");
});

test("refund recorded before fulfillment nets to zero when fulfilled", async () => {
  const { store, alerts, service } = await setupTopup({ fulfilled: false });

  const result = await service.applyPaymentReversal(reversal());

  assert.equal(result.outcome, "recorded_before_fulfillment");
  assert.equal(store.account?.addOnCreditsBalance, 0);
  assert.equal(store.order?.status, "payment_confirmed");
  assert.equal(store.order?.refundedAmount, 1000);
  assert.equal(store.order?.reversalStatus, "refunded");
  assert.equal(store.order?.reversedUnits, 0);
  const [recorded] = reversalRows(store);
  assert.equal(recorded?.delta, 0);
  assert.equal(recorded?.activityVisible, false);
  assert.equal(
    recorded?.idempotencyKey,
    "user_1:billing-order:order_1:reversal:refund_1",
  );
  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal:order_1", "warn"],
  ]);

  const fulfilled = await service.fulfillOrder({ orderId: "order_1" });

  assert.equal(fulfilled.status, "fulfilled");
  assert.equal(store.order?.status, "fulfilled");
  assert.equal(store.account?.addOnCreditsBalance, 0);
  assert.equal(store.account?.monthlyCreditsBalance, 40_000);
  assert.equal(
    store.ledgers.filter((entry) => entry.feature === "credit_topup_purchase")
      .length,
    1,
  );
  const fulfillmentRow = reversalRows(store).find(
    (row) =>
      row.idempotencyKey ===
      "user_1:billing-order:order_1:reversal:fulfillment",
  );
  assert.equal(fulfillmentRow?.delta, -20_000);
  assert.equal(fulfillmentRow?.activityVisible, true);
  assert.equal(fulfillmentRow?.metadata.reversalId, "fulfillment");
  assert.equal(store.order?.reversedUnits, 20_000);
  assert.equal(store.order?.reversalStatus, "refunded");
  assert.equal(store.order?.refundedAmount, 1000);
});

test("partial refund recorded before fulfillment grants the remainder", async () => {
  const { store, service } = await setupTopup({ fulfilled: false });

  const result = await service.applyPaymentReversal(
    reversal({ amount: { refundAmount: 250 } }),
  );
  assert.equal(result.outcome, "recorded_before_fulfillment");
  assert.equal(store.order?.reversalStatus, "partially_refunded");

  await service.fulfillOrder({ orderId: "order_1" });

  assert.equal(store.account?.addOnCreditsBalance, 15_000);
  assert.equal(store.order?.reversedUnits, 5_000);
  assert.equal(store.order?.reversalStatus, "partially_refunded");
  assert.equal(store.order?.refundedAmount, 250);
});

test("a redelivered partial refund while still unfulfilled is a duplicate, not a second reversal", async () => {
  const { store, service } = await setupTopup({ fulfilled: false });
  const event = reversal({ reversalId: "r1", amount: { refundAmount: 400 } });

  const first = await service.applyPaymentReversal(event);
  assert.equal(first.outcome, "recorded_before_fulfillment");
  assert.equal(store.order?.refundedAmount, 400);

  // The same event delivered again before fulfillment must not add another
  // 400 on top of the first: the ledger's reversal-id idempotency key catches
  // it before the order's `refundedAmount` is ever recomputed.
  const second = await service.applyPaymentReversal(event);
  assert.deepEqual(second, { outcome: "duplicate" });
  assert.equal(store.order?.refundedAmount, 400);
  assert.equal(reversalRows(store).length, 1);

  await service.fulfillOrder({ orderId: "order_1" });

  assert.equal(store.account?.addOnCreditsBalance, 12_000);
  assert.equal(store.order?.reversedUnits, 8_000);
  assert.equal(store.order?.refundedAmount, 400);
});

test("a recorded refund without an order amount is left for an operator at fulfillment", async () => {
  const { store, alerts, service } = await setupTopup({
    fulfilled: false,
    order: {
      amountTotal: null,
      refundedAmount: 1000,
      reversalStatus: "refunded",
    },
  });

  const fulfilled = await service.fulfillOrder({ orderId: "order_1" });

  assert.equal(fulfilled.status, "fulfilled");
  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.equal(store.order?.reversedUnits, 0);
  assert.equal(reversalRows(store).length, 0);
  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal-rejected:order_1", "error"],
  ]);
});

test("alert failures never fail a reversal or its fulfillment", async () => {
  const failingAlerts: BillingAlertSink = {
    async trigger() {
      throw new Error("alert sink down");
    },
    async resolve() {},
  };
  const { store, service } = await setupTopup({
    fulfilled: false,
    alerts: failingAlerts,
  });

  const recorded = await service.applyPaymentReversal(
    reversal({ amount: { refundAmount: 500 } }),
  );
  assert.equal(recorded.outcome, "recorded_before_fulfillment");
  await service.fulfillOrder({ orderId: "order_1" });
  assert.equal(store.order?.status, "fulfilled");
  assert.equal(store.account?.addOnCreditsBalance, 10_000);

  const logged: string[] = [];
  const direct = new BillingPaymentReversalService(
    store,
    new BillingAccountService(store, runtimeConfig),
    failingAlerts,
    {
      info() {},
      warn() {},
      error(message) {
        logged.push(message);
      },
    },
  );
  const applied = await direct.applyPaymentReversal(
    reversal({ reversalId: "refund_2", amount: { refundAmount: 500 } }),
  );

  assert.equal(applied.outcome, "applied");
  assert.equal(store.account?.addOnCreditsBalance, 0);
  assert.equal(logged.length, 1);
});

test("subscription orders only raise a notice", async () => {
  const store = new MemoryBillingStore();
  const alerts: RecordedAlert[] = [];
  const service = new BillingService(store, runtimeConfig, noopProvider, {
    async trigger(input) {
      alerts.push(input);
    },
    async resolve() {},
  });
  store.account = createActiveTeamAccount({ userId: "user_1" });
  store.order = createTopupOrder({
    kind: "subscription",
    status: "fulfilled",
    planFamily: "team_standard",
    billingInterval: "monthly",
    quantity: 2,
    unitType: null,
    unitAmount: null,
    grantedCredits: 0,
    externalSubscriptionId: "ext_sub_1",
    amountTotal: 4900,
  });

  const result = await service.applyPaymentReversal(
    reversal({ amount: { refundAmount: 4900 }, paidAmount: 4900 }),
  );

  assert.equal(result.outcome, "subscription_notice");
  assert.equal(store.ledgers.length, 0);
  assert.equal(store.account?.monthlyCreditsBalance, 40_000);
  assert.equal(store.order?.refundedAmount, 0);
  assert.deepEqual(alertLevels(alerts), [
    ["billing:subscription-payment-reversal:team_1", "error"],
  ]);
  assert.equal(alerts[0]?.source, "billing.payment-reversal");
});

test("notices raise the documented alerts", async () => {
  const { alerts, service } = await setupTopup();
  alerts.length = 0;

  const notices: Array<[PaymentReversalNotice, string, string]> = [
    [
      {
        reason: "subscription_payment",
        provider: "stripe",
        providerReference: "re_1",
        orderId: "order_9",
        teamId: "team_9",
      },
      "billing:subscription-payment-reversal:team_9",
      "error",
    ],
    [
      {
        reason: "subscription_payment",
        provider: "stripe",
        providerReference: "re_2",
        orderId: "order_9",
        teamId: null,
      },
      "billing:subscription-payment-reversal:order_9",
      "error",
    ],
    [
      {
        reason: "dispute_opened",
        provider: "stripe",
        providerReference: "dp_1",
      },
      "billing:dispute-opened:stripe:dp_1",
      "warn",
    ],
    [
      { reason: "unmatched", provider: "waffo", providerReference: "ref_1" },
      "billing:payment-reversal-unmatched:waffo:ref_1",
      "error",
    ],
    [
      {
        reason: "amount_unavailable",
        provider: "creem",
        providerReference: "ref_2",
      },
      "billing:payment-reversal-amount-unavailable:creem:ref_2",
      "error",
    ],
    [
      {
        reason: "refund_pending",
        provider: "waffo",
        providerReference: "ref_3",
      },
      "billing:payment-reversal-refund-pending:waffo:ref_3",
      "error",
    ],
  ];

  for (const [notice] of notices) {
    await service.paymentReversals.reportNotice(notice);
  }
  await service.reportPaymentReversalNotice(notices[2]![0]);

  assert.deepEqual(alertLevels(alerts), [
    ...notices.map(([, key, level]) => [key, level]),
    ["billing:dispute-opened:stripe:dp_1", "warn"],
  ]);
  assert.ok(
    alerts.every((alert) => alert.source === "billing.payment-reversal"),
  );
});

test("orders resolve by provider payment id", async () => {
  const { service } = await setupTopup();

  assert.equal(
    (await service.findOrderByProviderPaymentId("waffo", "pay_1"))?.id,
    "order_1",
  );
  assert.equal(
    await service.findOrderByProviderPaymentId("waffo", "pay_other"),
    null,
  );
});

test("a refund after a chargeback keeps the order charged back", async () => {
  const { store, service } = await setupTopup();
  await service.applyPaymentReversal(
    reversal({
      reversalId: "dispute_1",
      kind: "chargeback",
      amount: { refundedTotal: 0 },
    }),
  );

  const refund = await service.applyPaymentReversal(
    reversal({ reversalId: "refund_1", amount: { refundAmount: 400 } }),
  );

  assert.ok(refund.outcome === "applied");
  assert.equal(refund.deltaUnits, 0);
  assert.equal(store.order?.reversalStatus, "charged_back");
  assert.equal(store.order?.refundedAmount, 1000);
  assert.equal(store.order?.reversedUnits, 20_000);
  assert.equal(store.account?.addOnCreditsBalance, 0);
});

test("a chargeback recorded before fulfillment stays charged back through a later refund", async () => {
  const { store, service } = await setupTopup({ fulfilled: false });
  await service.applyPaymentReversal(
    reversal({
      reversalId: "dispute_1",
      kind: "chargeback",
      amount: { refundedTotal: 0 },
    }),
  );
  const refund = await service.applyPaymentReversal(
    reversal({ reversalId: "refund_1", amount: { refundAmount: 300 } }),
  );
  assert.equal(refund.outcome, "recorded_before_fulfillment");
  assert.equal(store.order?.reversalStatus, "charged_back");

  await service.fulfillOrder({ orderId: "order_1" });

  assert.equal(store.order?.status, "fulfilled");
  assert.equal(store.order?.reversalStatus, "charged_back");
  assert.equal(store.order?.reversedUnits, 20_000);
  assert.equal(store.account?.addOnCreditsBalance, 0);
  const fulfillmentRow = reversalRows(store).find(
    (row) => row.metadata.reversalId === "fulfillment",
  );
  assert.equal(fulfillmentRow?.delta, -20_000);
  assert.equal(fulfillmentRow?.feature, "payment_chargeback");
  assert.equal(fulfillmentRow?.activityTitle, "Credits top-up charged back");
});

test("a refund recorded before fulfillment is measured against the provider's paid amount", async () => {
  // amountTotal 1000; the provider charged 1100 (e.g. with tax).
  const { store, service } = await setupTopup({ fulfilled: false });

  await service.applyPaymentReversal(
    reversal({ paidAmount: 1100, amount: { refundAmount: 550 } }),
  );
  assert.equal(store.order?.metadata.reversalPaidAmount, 1100);
  assert.equal(store.order?.reversalStatus, "partially_refunded");

  await service.fulfillOrder({ orderId: "order_1" });

  assert.equal(store.order?.reversedUnits, 10_000);
  assert.equal(store.account?.addOnCreditsBalance, 10_000);
  const fulfillmentRow = reversalRows(store).find(
    (row) => row.metadata.reversalId === "fulfillment",
  );
  assert.equal(fulfillmentRow?.delta, -10_000);
  assert.equal(fulfillmentRow?.metadata.paidAmount, 1100);
  assert.equal(fulfillmentRow?.metadata.refundedTotal, 550);
});

test("a fully refunded order reverses the whole grant at fulfillment whatever the amounts", async () => {
  const { store, service } = await setupTopup({
    fulfilled: false,
    order: { refundedAmount: 400, reversalStatus: "refunded" },
  });

  await service.fulfillOrder({ orderId: "order_1" });

  assert.equal(store.order?.reversedUnits, 20_000);
  assert.equal(store.account?.addOnCreditsBalance, 0);
});

/**
 * The fulfilment hook's reversal alert must not go out until the fulfilment
 * transaction that produced it has actually committed: the final write
 * (`status: "fulfilled"`) fails once, rolling everything in that attempt
 * back (mirroring PostgreSQL), and only the successful retry may raise the
 * alert.
 */
class FinalFulfilledWriteFailsOnceStore extends MemoryBillingStore {
  private failuresLeft = 1;

  async updateOrder(
    ...args: Parameters<MemoryBillingStore["updateOrder"]>
  ): ReturnType<MemoryBillingStore["updateOrder"]> {
    const [order] = args;
    if (order.status === "fulfilled" && this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("db down");
    }
    return super.updateOrder(...args);
  }

  async runInTransaction<T>(
    ...args: Parameters<MemoryBillingStore["runInTransaction"]>
  ): Promise<T> {
    const order = this.order ? { ...this.order } : null;
    const account = this.account ? { ...this.account } : null;
    const ledgerCount = this.ledgers.length;
    try {
      return (await super.runInTransaction(...args)) as T;
    } catch (error) {
      this.order = order;
      this.account = account;
      this.ledgers.length = ledgerCount;
      throw error;
    }
  }
}

test("hook alerts are raised only after fulfilment commits", async () => {
  const store = new FinalFulfilledWriteFailsOnceStore();
  const { alerts, service } = await setupTopup({ store, fulfilled: false });

  await service.applyPaymentReversal(reversal());
  alerts.length = 0; // drop the "recorded before fulfillment" alert

  await assert.rejects(
    () => service.fulfillOrder({ orderId: "order_1" }),
    /db down/,
  );
  assert.equal(
    alerts.some(
      (alert) => alert.alertKey === "billing:payment-reversal:order_1",
    ),
    false,
  );

  alerts.length = 0;
  await service.fulfillOrder({ orderId: "order_1" });

  assert.deepEqual(alertLevels(alerts), [
    ["billing:payment-reversal:order_1", "warn"],
  ]);
});

/**
 * Models the order row lock around fulfillment-failure bookkeeping. The
 * first grant write fails, and the transaction's order, account and ledger
 * writes roll back as PostgreSQL would;
 * the next order read is `markFulfillmentFailed`'s, and a concurrent refund
 * races it. After an unlocked read the refund commits before the reader
 * writes back what it read; after a locked read the refund waits until the
 * reader's transaction commits (`blocked`, run by the test).
 */
class RacingReversalStore extends MemoryBillingStore {
  concurrentReversal: (() => Promise<unknown>) | null = null;
  blocked: (() => Promise<unknown>) | null = null;
  private grantFailuresLeft = 1;
  private race: (() => Promise<unknown>) | null = null;

  async appendLedger(
    ...args: Parameters<MemoryBillingStore["appendLedger"]>
  ): ReturnType<MemoryBillingStore["appendLedger"]> {
    if (this.grantFailuresLeft > 0) {
      this.grantFailuresLeft -= 1;
      this.race = this.concurrentReversal;
      throw new Error("ledger unavailable");
    }
    return super.appendLedger(...args);
  }

  async runInTransaction<T>(
    ...args: Parameters<MemoryBillingStore["runInTransaction"]>
  ): Promise<T> {
    const order = this.order ? { ...this.order } : null;
    const account = this.account ? { ...this.account } : null;
    const ledgerCount = this.ledgers.length;
    try {
      return (await super.runInTransaction(...args)) as T;
    } catch (error) {
      this.order = order;
      this.account = account;
      this.ledgers.length = ledgerCount;
      throw error;
    }
  }

  async getOrderById(
    ...args: Parameters<MemoryBillingStore["getOrderById"]>
  ): ReturnType<MemoryBillingStore["getOrderById"]> {
    const order = await super.getOrderById(...args);
    const race = this.takeRace();
    if (race) {
      await race();
    }
    return order;
  }

  async getOrderByIdForUpdate(
    ...args: Parameters<MemoryBillingStore["getOrderByIdForUpdate"]>
  ): ReturnType<MemoryBillingStore["getOrderByIdForUpdate"]> {
    const order = await super.getOrderByIdForUpdate(...args);
    this.blocked = this.takeRace() ?? this.blocked;
    return order;
  }

  private takeRace() {
    const race = this.race;
    this.race = null;
    return race;
  }
}

test("a refund that lands while fulfillment fails survives the failure bookkeeping", async () => {
  const store = new RacingReversalStore();
  const { service } = await setupTopup({ store, fulfilled: false });
  store.concurrentReversal = () => service.applyPaymentReversal(reversal());

  await assert.rejects(
    () =>
      service.fulfillOrder({ orderId: "order_1", externalPaymentId: "pay_1" }),
    /ledger unavailable/,
  );
  await store.blocked?.();

  assert.equal(store.order?.status, "fulfillment_failed");
  assert.equal(store.order?.externalPaymentId, "pay_1");
  assert.equal(store.order?.refundedAmount, 1000);
  assert.equal(store.order?.reversalStatus, "refunded");

  assert.deepEqual(await service.reconcileBillingOrders(), {
    checked: 1,
    retried: 1,
    failed: 0,
  });
  assert.equal(store.order?.status, "fulfilled");
  assert.equal(store.order?.reversedUnits, 20_000);
  assert.equal(store.account?.addOnCreditsBalance, 0);
  assert.deepEqual(await service.applyPaymentReversal(reversal()), {
    outcome: "duplicate",
  });
});
