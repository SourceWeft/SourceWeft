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

async function fixture() {
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

  // Fulfill the one-time top-up so its grant (1000 pages, paid 500 USD via
  // transaction `tran_test`) is on the books before any refund arrives —
  // the same checkout shape as creem-checkout.test.ts's fixture.
  await sync(
    "checkout.completed",
    {
      webhookId: "evt_checkout",
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
      },
    },
    "inactive",
  );

  return { config, store, billing, sync, reversalSync, handler, alerts };
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
        refunded_amount: 500,
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
  assert.equal(
    f.store.webhooks.get("creem:evt_refund_1")?.status,
    "processed",
  );
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
      refunded_amount: 250,
    },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_by_tx",
    webhookCreatedAt: Date.now(),
  });

  // refunded_amount(250) / paidAmount(500) of the 1000 granted pages.
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
      refunded_amount: 500,
    },
    webhookEventType: "refund.created",
    webhookId: "evt_refund_by_tx_no_metadata",
    webhookCreatedAt: Date.now(),
  });

  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal(reversalRows(f).length, 1);
  assert.equal(f.store.order?.reversalStatus, "refunded");
});

test("a succeeded Creem refund with unusable amounts raises the amount-unavailable alert", async () => {
  const f = await fixture();

  await f.reversalSync("refund.created", {
    id: "ref_amount_unavailable",
    status: "succeeded",
    // No `refund_amount` and no `transaction.refunded_amount`: neither a
    // per-refund amount nor a cumulative total is usable.
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
      refunded_amount: 500,
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
