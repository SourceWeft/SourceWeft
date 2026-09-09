import assert from "node:assert/strict";
import { test } from "vitest";
import { createHmac } from "node:crypto";
import { createCreemWebhookHandler } from "../src/server/providers/creem-webhook-bypass";
import { BillingService } from "../src/server/service";
import { createCreemSubscriptionSync } from "../src/server/providers/creem-subscription-sync";
import {
  MemoryBillingStore,
  runtimeConfig,
  noopProvider,
} from "./test-fixtures";

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
  const billing = new BillingService(store, config, {
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
  });
  await billing.ensureBillingAccount("team_1", "user_1");
  await billing.createTopupCheckout(
    "team_1",
    { unitType: "page", quantity: 1 },
    "user_1",
    "buyer@example.invalid",
  );
  const sync = createCreemSubscriptionSync({
    billing,
    config,
    logger: { info() {}, warn() {}, error() {} },
    alerts: { async trigger() {}, async resolve() {} },
  });
  const event = {
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
  };
  return { store, sync, event, config };
}

test("Creem webhook entry verifies raw signatures and invokes one-time fulfillment", async () => {
  const f = await fixture();
  const handler = createCreemWebhookHandler({
    config: f.config,
    sync: f.sync,
    logger: { info() {}, warn() {}, error() {} },
  });
  const raw = JSON.stringify(
    {
      id: f.event.webhookId,
      eventType: "checkout.completed",
      created_at: Date.now(),
      object: f.event,
    },
    null,
    2,
  );
  const signature = createHmac("sha256", f.config.creem.webhookSecret)
    .update(raw)
    .digest("hex");
  const deliver = async (sig: string) =>
    (await handler(
      new Request("http://localhost/api/auth/creem/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "creem-signature": sig },
        body: raw,
      }),
    ))!;
  assert.equal((await deliver("invalid")).status, 400);
  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal((await deliver(signature)).status, 200);
  assert.equal((await deliver(signature)).status, 200);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(f.store.order?.status, "fulfilled");
});

test("Creem returns HTTP 500 on processing failure so a signed retry can fulfill", async () => {
  const f = await fixture();
  let fail = true;
  const handler = createCreemWebhookHandler({
    config: f.config,
    logger: { info() {}, warn() {}, error() {} },
    sync: async (...args) => {
      if (fail) throw new Error("temporary database outage");
      await f.sync(...args);
    },
  });
  const raw = JSON.stringify({
    id: f.event.webhookId,
    eventType: "checkout.completed",
    created_at: Date.now(),
    object: f.event,
  });
  const signature = createHmac("sha256", f.config.creem.webhookSecret)
    .update(raw)
    .digest("hex");
  const deliver = () =>
    handler(
      new Request("http://localhost/api/auth/creem/webhook", {
        method: "POST",
        headers: { "creem-signature": signature },
        body: raw,
      }),
    );
  assert.equal((await deliver())?.status, 500);
  assert.equal(f.store.order?.paymentStatus, "unpaid");
  fail = false;
  assert.equal((await deliver())?.status, 200);
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
});

test("Creem checkout.completed fulfills one-time orders once through the common ledger", async () => {
  const f = await fixture();
  await f.sync("checkout.completed", f.event, "inactive");
  await f.sync("checkout.completed", f.event, "inactive");
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(f.store.account?.addOnPagesBalance, 1000);
  assert.equal(f.store.order?.externalPaymentId, "tran_test");
  assert.equal(
    f.store.ledgers.filter(
      (row) =>
        row.referenceId === f.store.order?.id && row.eventType === "grant",
    ).length,
    1,
  );
});

test.each([
  "mode",
  "amount",
  "currency",
  "product",
  "reference",
  "buyer",
  "checkout",
  "unpaid",
  "quantity",
])("Creem rejects %s mismatches without granting", async (kind) => {
  const f = await fixture();
  if (kind === "mode") f.event.mode = "prod";
  if (kind === "amount") f.event.order.amount = 1;
  if (kind === "currency") f.event.order.currency = "EUR";
  if (kind === "product") f.event.product.id = "prod_other";
  if (kind === "reference") f.event.request_id = "order:other";
  if (kind === "buyer") f.event.metadata.userId = "other";
  if (kind === "checkout") f.event.id = "ch_other";
  if (kind === "unpaid") f.event.order.status = "pending";
  if (kind === "quantity") f.event.units = 2;
  await assert.rejects(() => f.sync("checkout.completed", f.event, "inactive"));
  assert.equal(f.store.account?.addOnPagesBalance, 0);
  assert.equal(f.store.order?.paymentStatus, "unpaid");
});

test("Creem subscription checkout does not fabricate a period from checkout.completed", async () => {
  const f = await fixture();
  await f.sync(
    "checkout.completed",
    { ...f.event, subscription: { id: "sub_test" } },
    "inactive",
  );
  assert.equal(f.store.order?.paymentStatus, "unpaid");
  assert.equal(f.store.account?.addOnPagesBalance, 0);
});
