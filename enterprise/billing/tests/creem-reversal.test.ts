// Coverage for the Creem refund/dispute-to-reversal translation in
// creem-reversal-sync.ts. Like waffo.test.ts's refund coverage, these tests
// exercise only the mapping from a Creem event to the payment-reversal
// core's input, not the reversal math itself (covered in
// payment-reversal.test.ts).
import assert from "node:assert/strict";
import { test } from "vitest";
import { createHmac } from "node:crypto";
import { createCreemReversalSync } from "../src/server/providers/creem-reversal-sync";
import { createCreemSubscriptionSync } from "../src/server/providers/creem-subscription-sync";
import { createCreemWebhookHandler } from "../src/server/providers/creem-webhook-bypass";
import { BillingService } from "../src/server/service";
import type { BillingAlertSink } from "../src/server/host";
import {
  MemoryBillingStore,
  runtimeConfig,
  noopProvider,
} from "./test-fixtures";

const WEBHOOK_URL = "http://localhost/api/auth/creem/webhook";

type RecordedAlert = Parameters<BillingAlertSink["trigger"]>[0];

// Base fixture: an unfulfilled page top-up order, plus the sync/handler
// wiring. `fixture()` (below) also fulfills it with the plain, untaxed
// checkout shape used by most tests; a few tests need to control fulfillment
// themselves (a taxed payment, or no `transaction` id at all), so they call
// `baseFixture()` directly.
async function baseFixture() {
  const config = {
    ...runtimeConfig,
    saasEnabled: true,
    provider: "creem" as const,
    creem: {
      ...runtimeConfig.creem,
      apiKey: "creem_test_fixture",
      webhookSecret: "creem-fixture-signing-secret",
    },
  };
  const store = new MemoryBillingStore();
  const alerts: RecordedAlert[] = [];
  const alertSink: BillingAlertSink = {
    async trigger(input) {
      alerts.push(input);
    },
    async resolve() {},
  };
  const billing = new BillingService(
    store,
    config,
    {
      ...noopProvider,
      async checkoutMetadata() {
        return { paymentEnvironment: "test" };
      },
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://test-checkout.creem.io/test",
          externalCheckoutId: "ch_test",
          externalCustomerId: null,
        };
      },
    },
    alertSink,
  );
  const logger = { info() {}, warn() {}, error() {} };
  const sync = createCreemSubscriptionSync({
    billing,
    config,
    logger,
    alerts: alertSink,
  });
  const reversalSync = createCreemReversalSync({ billing, logger });
  const handler = createCreemWebhookHandler({
    config,
    logger,
    sync,
    reversalSync,
  });

  await billing.ensureBillingAccount("team_1", "user_1");
  await billing.createTopupCheckout(
    "team_1",
    { unitType: "page", quantity: 1 },
    "user_1",
    "buyer@example.invalid",
  );

  return { config, store, billing, sync, reversalSync, handler, alerts };
}

// The same checkout shape as creem-checkout.test.ts's fixture: a completed
// one-time payment for order `ord_test` via transaction `tran_test`, with no
// tax. `orderOverrides` lets a test swap in a taxed payment or drop the
// `transaction` field entirely.
function checkoutCompletedEvent(
  store: MemoryBillingStore,
  webhookId: string,
  orderOverrides: Record<string, unknown> = {},
) {
  return {
    webhookId,
    id: "ch_test",
    object: "checkout",
    status: "completed",
    mode: "test",
    units: 1,
    request_id: `order:${store.order!.id}`,
    metadata: {
      orderId: store.order!.id,
      userId: "user_1",
      teamId: "team_1",
      kind: "page_topup",
    },
    product: { id: store.order!.externalProductId },
    customer: { id: "cust_test" },
    order: {
      id: "ord_test",
      product: store.order!.externalProductId,
      transaction: "tran_test",
      amount: 500,
      currency: "USD",
      status: "paid",
      type: "onetime",
      mode: "test",
      ...orderOverrides,
    },
  };
}

async function fixture() {
  const f = await baseFixture();

  // Fulfill the one-time top-up so its grant (1000 pages, paid 500 USD via
  // transaction `tran_test`) is on the books before any refund arrives.
  await f.sync(
    "checkout.completed",
    checkoutCompletedEvent(f.store, "evt_checkout"),
    "inactive",
  );

  return f;
}

function reversalRows(f: Awaited<ReturnType<typeof fixture>>) {
  return f.store.ledgers.filter(
    (entry) => entry.operationType === "payment_reversal",
  );
}

function sign(raw: string, secret = "creem-fixture-signing-secret") {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

function post(body: string, signature: string) {
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "creem-signature": signature,
    },
    body,
  });
}

test("a succeeded Creem refund reverses the top-up once", async () => {
  const f = await fixture();
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(f.store.account?.addOnPagesBalance, 1000);

  const refund = {
    id: "evt_refund_1",
    eventType: "refund.created",
    created_at: Date.now(),
    object: {
      id: "ref_test",
      mode: "test",
      status: "succeeded",
      refund_amount: 500,
      refund_currency: "USD",
      reason: "requested_by_customer",
      transaction: {
        id: "tran_test",
        amount: 500,
        amount_paid: 500,
        currency: "USD",
        status: "paid",
        // Snapshot before this (only) refund: no prior refunds.
        refunded_amount: null,
      },
      checkout: {
        id: "ch_test",
        metadata: { orderId: f.store.order!.id },
      },
    },
  };
  const raw = JSON.stringify(refund);
  const signature = sign(raw);

  const first = await f.handler(post(raw, signature));
  assert.equal(first?.status, 200);
  const second = await f.handler(post(raw, signature));
  assert.equal(second?.status, 200);

  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal(reversalRows(f).length, 1);
  assert.equal(f.store.order?.reversalStatus, "refunded");
  assert.equal(f.store.webhooks.get("creem:evt_refund_1")?.status, "processed");
});

test("a Creem refund found by transaction id when checkout metadata is absent", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_by_tx",
    status: "succeeded",
    refund_amount: 250,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      // Snapshot before this (only) refund: no prior refunds.
      refunded_amount: null,
    },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_by_tx",
    webhookCreatedAt: Date.now(),
  });

  // refund_amount(250) / paidAmount(500) of the 1000 granted pages.
  assert.equal(f.store.account?.addOnPagesBalance, 500);
  assert.equal(reversalRows(f).length, 1);
  assert.equal(f.store.order?.reversalStatus, "partially_refunded");
});

test("a Creem refund found by transaction id when checkout metadata is missing", async () => {
  const f = await fixture();

  // `checkout` is present (unlike the previous test) but carries no
  // `metadata.orderId` — the lookup must still fall back to the
  // transaction id rather than treating this as unmatched.
  await f.reversalSync("refund.created", {
    id: "ref_by_tx_no_metadata",
    status: "succeeded",
    refund_amount: 500,
    refund_currency: "USD",
    checkout: { id: "ch_test", metadata: {} },
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      // Snapshot before this (only) refund: no prior refunds.
      refunded_amount: null,
    },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_by_tx_no_metadata",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal(reversalRows(f).length, 1);
  assert.equal(f.store.order?.reversalStatus, "refunded");
});

test("a Creem refund found by the Creem order id when the checkout carried no transaction id", async () => {
  const f = await baseFixture();

  // Creem's documented checkout.completed order shape has no `transaction`
  // field at all — not every top-up is stored under a transaction id;
  // creem-checkout-sync.ts falls back to the payment's own id (`ord_test`).
  await f.sync(
    "checkout.completed",
    checkoutCompletedEvent(f.store, "evt_checkout_no_tx", {
      transaction: undefined,
    }),
    "inactive",
  );
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(f.store.order?.externalPaymentId, "ord_test");
  assert.equal(f.store.account?.addOnPagesBalance, 1000);

  // No `checkout` field, and the refund's own `transaction` id does not
  // match anything local — only the refund's `order` reference does.
  await f.reversalSync("refund.created", {
    id: "ref_by_order_id",
    status: "succeeded",
    refund_amount: 500,
    refund_currency: "USD",
    order: "ord_test",
    transaction: {
      id: "tran_unrelated",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      // Snapshot before this (only) refund: no prior refunds.
      refunded_amount: null,
    },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_by_order_id",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal(reversalRows(f).length, 1);
});

test("a succeeded Creem refund with unusable amounts raises the amount-unavailable alert", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_amount_unavailable",
    status: "succeeded",
    // No `refund_amount` at all: nothing to reverse, regardless of any
    // prior total.
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_amount_unavailable",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  assert.equal(
    f.store.webhooks.get("creem:evt_refund_amount_unavailable")?.status,
    "processed",
  );
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey ===
        "billing:payment-reversal-amount-unavailable:creem:ref_amount_unavailable",
    ),
  );
});

test("successive partial refunds each reverse their own amount", async () => {
  const f = await fixture();

  // Same shape as the observed Creem test-mode events on one $5.00
  // payment: refund_amount 100 (prior null), then 150 (prior 100), then
  // 250 (prior 250). Each `transaction.refunded_amount` is the snapshot
  // from BEFORE that refund.
  await f.reversalSync("refund.created", {
    id: "ref_multi_1",
    status: "succeeded",
    refund_amount: 100,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_multi_1",
    webhookCreatedAt: Date.now(),
  });
  await f.reversalSync("refund.created", {
    id: "ref_multi_2",
    status: "succeeded",
    refund_amount: 150,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: 100,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_multi_2",
    webhookCreatedAt: Date.now(),
  });
  await f.reversalSync("refund.created", {
    id: "ref_multi_3",
    status: "succeeded",
    refund_amount: 250,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: 250,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_multi_3",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 500);
  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal(reversalRows(f).length, 3);
});

test("a later refund smaller than an earlier one is still reversed", async () => {
  const f = await fixture();

  // This is the silent under-reversal case: the old code preferred
  // `transaction.refunded_amount` (300, read as a stale cumulative total)
  // over this event's own smaller `refund_amount` (100), so the core saw
  // no change from the first refund's total and applied nothing.
  await f.reversalSync("refund.created", {
    id: "ref_shrink_1",
    status: "succeeded",
    refund_amount: 300,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_shrink_1",
    webhookCreatedAt: Date.now(),
  });
  await f.reversalSync("refund.created", {
    id: "ref_shrink_2",
    status: "succeeded",
    refund_amount: 100,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: 300,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_shrink_2",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 400);
  assert.equal(f.store.account?.addOnPagesBalance, 200);
  assert.equal(reversalRows(f).length, 2);
});

test("a redelivered refund does not reverse twice", async () => {
  const f = await fixture();
  const event = {
    id: "ref_redelivered",
    status: "succeeded",
    refund_amount: 500,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created" as const,
    webhookCreatedAt: Date.now(),
  };

  // Different webhook delivery ids, same refund id: the webhook-receipt
  // dedupe (keyed by webhookId) does not prevent a second delivery from
  // reaching the reversal core, so idempotency here comes from the core's
  // own ledger key, which is keyed by the refund id (`reversalId`).
  await f.reversalSync("refund.created", {
    ...event,
    webhookId: "evt_redelivered_1",
  });
  await f.reversalSync("refund.created", {
    ...event,
    webhookId: "evt_redelivered_2",
  });

  assert.equal(f.store.order?.refundedAmount, 500);
  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal(reversalRows(f).length, 1);
});

test("out-of-order delivery still sums to the same total", async () => {
  const f = await fixture();

  // Same three refund amounts as "successive partial refunds" (100, 150,
  // 250), delivered out of the order Creem created them in. Each event's
  // own `prior` is only a per-event consistency check against
  // amount_paid; the actual running total the core tracks is
  // order.refundedAmount + this event's own refund_amount, so the result
  // does not depend on delivery order.
  await f.reversalSync("refund.created", {
    id: "ref_order_2",
    status: "succeeded",
    refund_amount: 150,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: 100,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_order_2",
    webhookCreatedAt: Date.now(),
  });
  await f.reversalSync("refund.created", {
    id: "ref_order_1",
    status: "succeeded",
    refund_amount: 100,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_order_1",
    webhookCreatedAt: Date.now(),
  });
  await f.reversalSync("refund.created", {
    id: "ref_order_3",
    status: "succeeded",
    refund_amount: 250,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: 250,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_order_3",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 500);
  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal(reversalRows(f).length, 3);
});

test("a refund exceeding the paid amount with prior refunds raises amount-unavailable", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_exceeds_paid",
    status: "succeeded",
    refund_amount: 300,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      // prior(250) + refund_amount(300) = 550 > amount_paid(500).
      refunded_amount: 250,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_exceeds_paid",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 0);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-amount-unavailable:creem:ref_exceeds_paid",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.cause, "exceeds_paid");
  assert.equal(alert?.metadata?.prior, 250);
  assert.equal(alert?.metadata?.refundAmount, 300);
  assert.equal(alert?.metadata?.paidAmount, 500);
});

test("a missing refund_amount raises amount-unavailable even when refunded_amount is present", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_missing_amount",
    status: "succeeded",
    refund_currency: "USD",
    // No `refund_amount`, even though a prior total is present.
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: 250,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_missing_amount",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 0);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-amount-unavailable:creem:ref_missing_amount",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.cause, "refund_amount_invalid");
});

test("a zero refund_amount raises amount-unavailable", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_zero_amount",
    status: "succeeded",
    refund_amount: 0,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_zero_amount",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 0);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-amount-unavailable:creem:ref_zero_amount",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.cause, "refund_amount_invalid");
});

test("a negative refund_amount raises amount-unavailable", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_negative_amount",
    status: "succeeded",
    refund_amount: -100,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_negative_amount",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 0);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-amount-unavailable:creem:ref_negative_amount",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.cause, "refund_amount_invalid");
});

test("a NaN refund_amount raises amount-unavailable", async () => {
  const f = await fixture();

  // A NaN can never arrive through JSON.parse; this exercises a caller that
  // constructs the event object directly. Both `NaN <= 0` and `NaN ===
  // null` are false, so a non-finite value must be filtered before it ever
  // reaches amountUnavailableCause's `refundAmount <= 0` guard, or it would
  // evade it and reach the reversal core.
  await f.reversalSync("refund.created", {
    id: "ref_nan_amount",
    status: "succeeded",
    refund_amount: Number.NaN,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_nan_amount",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 0);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-amount-unavailable:creem:ref_nan_amount",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.cause, "refund_amount_invalid");
});

test("a succeeded refund with no refund id raises amount-unavailable instead of keying the ledger on the webhook id", async () => {
  const f = await fixture();

  // No `id` field at all: falling back to `webhookId` for the reversal
  // ledger key would let the same refund be counted twice if a later
  // redelivery arrived under a different webhook id, so this must not
  // apply anything even though every other field is usable.
  await f.reversalSync("refund.created", {
    status: "succeeded",
    refund_amount: 500,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_no_id",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 0);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-amount-unavailable:creem:evt_refund_no_id",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.cause, "refund_id_missing");
});

test("a refund whose transaction has no amount_paid raises the amount-unavailable alert", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_no_paid_amount",
    status: "succeeded",
    refund_amount: 500,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      // No `amount_paid`: must not silently fall back to the pre-tax
      // `amount` (which would understate a taxed refund's basis).
      amount: 500,
      currency: "USD",
      // No prior refunds either: isolates the amount_paid guard so this
      // test cannot pass merely because the consistency check tripped.
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_no_paid_amount",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-amount-unavailable:creem:ref_no_paid_amount",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.cause, "paid_amount_missing");
});

test("a refund with no currency anywhere raises the amount-unavailable alert", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_no_currency",
    status: "succeeded",
    refund_amount: 500,
    // No `refund_currency`, and the transaction has no `currency` either.
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      // No prior refunds either: isolates the currency guard so this test
      // cannot pass merely because the consistency check tripped (500 +
      // 500 prior would exceed paidAmount regardless of currency).
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_no_currency",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-amount-unavailable:creem:ref_no_currency",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.cause, "currency_missing");
});

test("a taxed refund reverses against the tax-inclusive paid amount, not the pre-tax subtotal", async () => {
  const f = await baseFixture();
  await f.sync(
    "checkout.completed",
    checkoutCompletedEvent(f.store, "evt_checkout_taxed", {
      amount_paid: 605,
      tax_amount: 105,
    }),
    "inactive",
  );
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(f.store.order?.amountTotal, 500);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);

  await f.reversalSync("refund.created", {
    id: "ref_taxed",
    status: "succeeded",
    refund_amount: 302,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 605,
      currency: "USD",
      // Snapshot before this (only) refund: no prior refunds.
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_taxed",
    webhookCreatedAt: Date.now(),
  });

  // floor(1000 * 302 / 605) = 499, measured against the tax-inclusive 605
  // Creem actually charged, not the pre-tax 500 subtotal (which would give
  // floor(1000 * 302 / 500) = 604 and over-reverse).
  assert.equal(f.store.account?.addOnPagesBalance, 501);
  assert.equal(reversalRows(f).length, 1);
});

test("a taxed refund recorded before fulfillment reverses against the tax-inclusive paid amount at fulfillment", async () => {
  const f = await baseFixture();

  await f.reversalSync("refund.created", {
    id: "ref_taxed_early",
    status: "succeeded",
    refund_amount: 302,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 605,
      currency: "USD",
      // Snapshot before this (only) refund: no prior refunds.
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_taxed_early",
    webhookCreatedAt: Date.now(),
  });

  assert.notEqual(f.store.order?.status, "fulfilled");
  assert.equal(f.store.account?.addOnPagesBalance, 0);

  await f.sync(
    "checkout.completed",
    checkoutCompletedEvent(f.store, "evt_checkout_taxed_early", {
      amount_paid: 605,
      tax_amount: 105,
    }),
    "inactive",
  );

  assert.equal(f.store.order?.status, "fulfilled");
  // The pre-fulfillment reversal recorded the tax-inclusive paidAmount
  // (605) as `reversalPaidAmount`; fulfillment reverses
  // floor(1000 * 302 / 605) = 499 immediately, end to end.
  assert.equal(f.store.account?.addOnPagesBalance, 501);
});

test("refunds recorded before fulfilment still sum with a refund that arrives after", async () => {
  const f = await baseFixture();

  // Same three amounts as "successive partial refunds" (100, 150, 250),
  // but the first two arrive before the top-up is ever fulfilled.
  await f.reversalSync("refund.created", {
    id: "ref_prefulfil_1",
    status: "succeeded",
    refund_amount: 100,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_prefulfil_1",
    webhookCreatedAt: Date.now(),
  });
  await f.reversalSync("refund.created", {
    id: "ref_prefulfil_2",
    status: "succeeded",
    refund_amount: 150,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: 100,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_prefulfil_2",
    webhookCreatedAt: Date.now(),
  });

  assert.notEqual(f.store.order?.status, "fulfilled");
  assert.equal(f.store.order?.refundedAmount, 250);
  assert.equal(f.store.account?.addOnPagesBalance, 0);

  await f.sync(
    "checkout.completed",
    checkoutCompletedEvent(f.store, "evt_checkout_prefulfil"),
    "inactive",
  );

  assert.equal(f.store.order?.status, "fulfilled");
  // floor(1000 * 250 / 500) = 500 reversed immediately at fulfillment.
  assert.equal(f.store.account?.addOnPagesBalance, 500);

  // A third refund, for the remainder, arrives after fulfillment.
  await f.reversalSync("refund.created", {
    id: "ref_prefulfil_3",
    status: "succeeded",
    refund_amount: 250,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: 250,
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_prefulfil_3",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.order?.refundedAmount, 500);
  assert.equal(f.store.account?.addOnPagesBalance, 0);
  // One ledger row per pre-fulfillment refund recorded (2), one for
  // fulfillment applying the recorded total in one lump sum (reversal id
  // "fulfillment", not a per-refund id), and one for the refund that
  // arrives after fulfillment.
  assert.equal(reversalRows(f).length, 4);
});

test("a pending Creem refund raises the pending alert and changes nothing", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_pending",
    status: "pending",
    refund_amount: 500,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_pending",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey ===
        "billing:payment-reversal-refund-pending:creem:ref_pending",
    ),
  );
});

test("a Creem refund with no status raises the pending alert and changes nothing", async () => {
  const f = await fixture();

  // No `status` field at all — not final yet, same as an explicit
  // "pending"/"requiresAction"; must not be treated as succeeded.
  await f.reversalSync("refund.created", {
    id: "ref_no_status",
    refund_amount: 500,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_no_status",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-refund-pending:creem:ref_no_status",
  );
  assert.ok(alert);
  // The raw (missing) status is carried in the notice's metadata.
  assert.equal(alert?.metadata?.status, null);
});

test("a failed Creem refund is ignored", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_failed",
    status: "failed",
    refund_amount: 500,
    refund_currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_failed",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  assert.equal(f.alerts.length, 0);
  // "log and return": a failed refund never even becomes a webhook receipt.
  assert.equal(f.store.webhooks.get("creem:evt_refund_failed"), undefined);
});

test("a Creem dispute only raises the dispute-opened alert", async () => {
  const f = await fixture();

  await f.reversalSync("dispute.created", {
    id: "dis_test",
    amount: 500,
    currency: "USD",
    transaction: {
      id: "tran_test",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
    },
    checkout: { metadata: { orderId: f.store.order!.id } },
    webhookEventType: "dispute.created",
    webhookId: "evt_dispute_1",
    webhookCreatedAt: Date.now(),
  });

  // A dispute that is only opened never changes balances.
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) => entry.alertKey === "billing:dispute-opened:creem:dis_test",
  );
  assert.ok(alert);
  assert.equal(alert?.level, "warn");
  assert.equal(alert?.metadata?.orderId, f.store.order!.id);
  assert.equal(alert?.metadata?.amount, 500);
  assert.equal(alert?.metadata?.currency, "USD");
});

test("an unmatched Creem refund raises the unmatched alert", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_unmatched",
    status: "succeeded",
    refund_amount: 500,
    refund_currency: "USD",
    transaction: {
      id: "tran_other",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_unmatched",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey ===
        "billing:payment-reversal-unmatched:creem:ref_unmatched",
    ),
  );
});

// A subscription renewal payment has no local order row (Creem does not
// create one for recurring charges), so a refund of one only ever resolves
// through the provider subscription id — never through `resolveOrder`. The
// subscription fixture below stands in for the row `syncSubscriptionSnapshot`
// would have written when the subscription itself was first activated.
function activeSubscriptionFixture() {
  const now = new Date().toISOString();
  return {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem" as const,
    planFamily: "individual_pro" as const,
    status: "active" as const,
    billingInterval: "monthly" as const,
    currentPeriodStart: now,
    currentPeriodEnd: now,
    externalCustomerId: "cus_1",
    externalSubscriptionId: "sub_ext_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_individual_monthly",
    billingOrderId: "order_sub_1",
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

test("a Creem renewal refund with no local order raises the subscription notice", async () => {
  const f = await fixture();
  f.store.subscription = activeSubscriptionFixture();

  await f.reversalSync("refund.created", {
    id: "ref_renewal",
    status: "succeeded",
    refund_amount: 1200,
    refund_currency: "USD",
    subscription: "sub_ext_1",
    transaction: {
      id: "tran_renewal",
      type: "payment",
      amount: 1200,
      amount_paid: 1200,
      currency: "USD",
      refunded_amount: null,
    },
    order: { type: "recurring" },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_renewal",
    webhookCreatedAt: Date.now(),
  });

  // Never changes balances: the reversal core is never invoked for a
  // subscription-payment notice.
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey === "billing:subscription-payment-reversal:team_1",
  );
  assert.ok(alert);
  assert.equal(alert?.teamId, "team_1");
  assert.equal(alert?.metadata?.reason, "subscription_payment");
  assert.equal(alert?.metadata?.orderId, "order_sub_1");
  assert.equal(
    f.store.webhooks.get("creem:evt_refund_renewal")?.status,
    "processed",
  );
});

test("a Creem refund with an unknown subscription id still ends unmatched", async () => {
  const f = await fixture();
  // No subscription recorded at all: the lookup must fail closed, not
  // silently treat the refund as matched.

  await f.reversalSync("refund.created", {
    id: "ref_unknown_subscription",
    status: "succeeded",
    refund_amount: 500,
    refund_currency: "USD",
    subscription: "sub_does_not_exist",
    transaction: {
      id: "tran_other",
      amount: 500,
      amount_paid: 500,
      currency: "USD",
      refunded_amount: null,
    },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_unknown_subscription",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey ===
      "billing:payment-reversal-unmatched:creem:ref_unknown_subscription",
  );
  assert.ok(alert);
  assert.equal(alert?.metadata?.reason, "unmatched");
});

test("a Creem dispute with no local order still resolves the team through the subscription", async () => {
  const f = await fixture();
  f.store.subscription = activeSubscriptionFixture();

  await f.reversalSync("dispute.created", {
    id: "dis_renewal",
    amount: 1200,
    currency: "USD",
    subscription: "sub_ext_1",
    transaction: {
      id: "tran_dispute_renewal",
      type: "payment",
      amount: 1200,
      amount_paid: 1200,
      currency: "USD",
    },
    order: { type: "recurring" },
    webhookEventType: "dispute.created",
    webhookId: "evt_dispute_renewal",
    webhookCreatedAt: Date.now(),
  });

  // A dispute always stays a dispute-opened notice; only the team/order it
  // carries changes.
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  const alert = f.alerts.find(
    (entry) => entry.alertKey === "billing:dispute-opened:creem:dis_renewal",
  );
  assert.ok(alert);
  assert.equal(alert?.teamId, "team_1");
  assert.equal(alert?.metadata?.orderId, "order_sub_1");
});
