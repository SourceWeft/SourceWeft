import assert from "node:assert/strict";
import { createHash, verify } from "node:crypto";
import { test } from "vitest";
import { Hono } from "hono";
import {
  readBillingConfig,
  validateBillingConfiguration,
} from "../src/server/config";
import { registerWaffoWebhook } from "../src/integrations/waffo";
import {
  centsToDisplay,
  displayToCents,
} from "../src/server/providers/waffo/client";
import { WAFFO_WEBHOOK_EVENTS } from "../src/server/providers/waffo/webhook";
import {
  createWaffoFixture,
  merchantId,
  productId,
  signingKey,
  signedEvent,
  storeId,
  waffoConfig,
} from "./waffo-fixtures";

const checkout = async (f: ReturnType<typeof createWaffoFixture>) => {
  await f.billing.ensureBillingAccount("team_1", "user_1");
  return f.billing.createTopupCheckout(
    "team_1",
    { unitType: "credit", quantity: 1, clientReferenceKey: "test-checkout" },
    "user_1",
    "buyer@example.invalid",
  );
};

test("provider selection is explicit and Waffo needs only its two new credentials", () => {
  const credentials = {
    WAFFO_MERCHANT_ID: merchantId,
    WAFFO_PRIVATE_KEY: signingKey.privateKey,
  };
  assert.equal(
    readBillingConfig(credentials, "http://localhost").provider,
    "none",
  );
  const config = readBillingConfig(
    {
      ...credentials,
      SOURCEWEFT_SAAS_ENABLED: "true",
      BACKEND_BILLING_PROVIDER: "waffo",
    },
    "http://localhost",
  );
  assert.equal(config.waffo.environment, "test");
  assert.equal(config.creem.apiKey, "");
  validateBillingConfiguration(config);
  assert.throws(
    () =>
      validateBillingConfiguration({
        ...config,
        waffo: { ...config.waffo, merchantId: storeId },
      }),
    /Merchant ID/,
  );
  assert.throws(
    () =>
      validateBillingConfiguration({
        ...config,
        waffo: { ...config.waffo, privateKey: "invalid" },
      }),
    /private key/,
  );
  assert.throws(
    () => readBillingConfig({ WAFFO_ENVIRONMENT: "other" }, "http://localhost"),
    /WAFFO_ENVIRONMENT/,
  );
});

test("official SDK signs checkout requests and uses display amounts and the Merchant ID", async () => {
  const f = createWaffoFixture();
  const result = await checkout(f);
  const request = f.requests[0]!;
  assert.equal(result.provider, "waffo");
  assert.equal(request.headers.get("X-Merchant-Id"), merchantId);
  assert.equal(request.body.priceSnapshot.amount, "12.50");
  assert.equal(request.body.productType, undefined);
  assert.equal(request.body.withTrial, false);
  assert.equal(request.body.orderMerchantExternalId, result.orderId);
  assert.equal(f.store.order?.metadata.waffoStoreId, storeId);
  const raw = JSON.stringify(request.body);
  const canonical = `POST\n${new URL(request.url).pathname}\n${request.headers.get("X-Timestamp")}\n${createHash("sha256").update(raw).digest("base64")}`;
  assert.equal(
    verify(
      "sha256",
      Buffer.from(canonical),
      signingKey.publicKey,
      Buffer.from(request.headers.get("X-Signature")!, "base64"),
    ),
    true,
  );
  assert.equal(centsToDisplay(1250), "12.50");
  assert.equal(displayToCents("12.50"), 1250);
  assert.throws(() => displayToCents("12.501"));
  assert.throws(() => centsToDisplay(1.5));
});

test("verified delivery is durable before fulfillment and restart/replay grants credits only once", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const before = f.store.account!.addOnCreditsBalance;
  const payload = signedEvent(f.event());
  await f.inbox.receive(payload.raw, payload.signature);
  assert.equal(f.store.account!.addOnCreditsBalance, before);
  assert.equal(f.store.webhook?.status, "received");
  await f.makeInbox().drain();
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    before + waffoConfig.catalog.creditTopupUnitAmount,
  );
  await f.inbox.receive(payload.raw, payload.signature);
  await Promise.all([f.makeInbox().drain(), f.makeInbox().drain()]);
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    before + waffoConfig.catalog.creditTopupUnitAmount,
  );
  assert.equal(f.store.webhook?.status, "processed");
});

test("webhook endpoint uses exact raw body and rejects missing, altered and expired signatures", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const app = new Hono();
  registerWaffoWebhook(app, f.inbox);
  const valid = signedEvent(f.event());
  for (const value of [
    { raw: valid.raw, signature: "" },
    { raw: valid.raw + " ", signature: valid.signature },
    signedEvent(f.event(), Date.now() - 46 * 60_000),
    signedEvent(f.event(), Date.now() + 2 * 60_000),
  ]) {
    const response = await app.request("/v1/billing/webhooks/waffo", {
      method: "POST",
      body: value.raw,
      headers: { "x-waffo-signature": value.signature },
    });
    assert.equal(response.status, 401);
  }
  assert.equal(f.store.webhooks.size, 0);
  const response = await app.request("/v1/billing/webhooks/waffo", {
    method: "POST",
    body: valid.raw,
    headers: { "x-waffo-signature": valid.signature },
  });
  assert.equal(response.status, 200);
  await f.inbox.drain();
});

test("wrong environment and store are rejected before persistence", async () => {
  for (const overrides of [
    { mode: "prod" as const },
    { storeId: "STO_other" },
  ]) {
    const f = createWaffoFixture();
    await checkout(f);
    const payload = signedEvent(f.event(overrides));
    await assert.rejects(
      f.inbox.receive(payload.raw, payload.signature),
      (error: any) => error.statusCode === 403,
    );
    assert.equal(f.store.webhooks.size, 0);
  }
});

test("amount, currency and order-binding mismatches never grant credits", async () => {
  for (const mutate of [
    (event: ReturnType<ReturnType<typeof createWaffoFixture>["event"]>) => {
      event.data.amount = "1.00";
      event.data.total = "1.00";
    },
    (event: ReturnType<ReturnType<typeof createWaffoFixture>["event"]>) => {
      event.data.currency = "EUR";
    },
    (event: ReturnType<ReturnType<typeof createWaffoFixture>["event"]>) => {
      event.data.orderMerchantExternalId = "different-order";
    },
  ]) {
    const f = createWaffoFixture();
    await checkout(f);
    const event = f.event();
    mutate(event);
    const payload = signedEvent(event);
    await f.inbox.receive(payload.raw, payload.signature);
    await f.inbox.drain();
    assert.equal(f.store.webhook?.status, "failed");
    assert.equal(f.store.account!.addOnCreditsBalance, 0);
    assert.equal(f.store.order?.paymentStatus, "unpaid");
  }
});

test("failed processing stays durable and is retried after recovery", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const original = f.billing.fulfillOrder.bind(f.billing);
  f.billing.fulfillOrder = async () => {
    throw new Error("temporary failure");
  };
  const payload = signedEvent(f.event());
  await f.inbox.receive(payload.raw, payload.signature);
  await f.inbox.drain();
  assert.equal(f.store.webhook?.status, "failed");
  f.billing.fulfillOrder = original;
  await f.makeInbox().drain();
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.order?.status, "fulfilled");
});

test("Waffo seat changes fail explicitly without calling another provider", async () => {
  const f = createWaffoFixture();
  await assert.rejects(
    f.provider.updateSubscriptionSeats({
      teamId: "t",
      externalSubscriptionId: "ORD_test",
      seatCount: 3,
      updateBehavior: "proration-none",
    }),
    (error: any) => error.code === "WAFFO_SEAT_UPDATE_UNSUPPORTED",
  );
  assert.equal(f.requests.length, 0);
});

test("expired Waffo top-up checkout refreshes the same persisted purchase and rejects changed intent", async () => {
  const f = createWaffoFixture();
  const first = await checkout(f);
  f.store.order!.expiresAt = new Date(Date.now() - 60_000).toISOString();
  const refreshed = await checkout(f);
  assert.equal(refreshed.orderId, first.orderId);
  assert.equal(f.requests.length, 2);
  await assert.rejects(
    f.billing.createTopupCheckout(
      "team_1",
      { unitType: "credit", quantity: 2, clientReferenceKey: "test-checkout" },
      "user_1",
      "buyer@example.invalid",
    ),
    (error: any) => error.code === "BILLING_CHECKOUT_REFERENCE_CONFLICT",
  );
});

test("changing the Waffo environment does not reuse a test checkout URL or reference", async () => {
  const f = createWaffoFixture();
  const { BillingService } = await import("../src/server/service");
  const { WaffoBillingProvider } =
    await import("../src/server/providers/waffo/provider");
  await f.billing.ensureBillingAccount("team_1", "user_1");
  const input = {
    plan: "pro" as const,
    billingInterval: "monthly" as const,
    source: "dashboard" as const,
    clientReferenceKey: "same-client-reference",
  };
  const actor = { userId: "user_1", email: "buyer@example.invalid" };
  const first = await f.billing.createPricingCheckout(input, actor, {
    personalTeamId: "team_1",
  });
  const config = {
    ...waffoConfig,
    waffo: { ...waffoConfig.waffo, environment: "prod" as const },
  };
  f.state.settings!.environment = "prod";
  const billing = new BillingService(
    f.store,
    config,
    new WaffoBillingProvider(config, f.state, f.client),
  );
  await assert.rejects(
    () =>
      billing.createPricingCheckout(input, actor, {
        personalTeamId: "team_1",
      }),
    (error: any) => error.code === "SUBSCRIPTION_OPERATION_CONFLICT",
  );
  assert.equal(f.store.order?.id, first.orderId);
  assert.equal(f.store.order?.metadata.waffoEnvironment, "test");
});

// Waffo is the first provider wired to the payment-reversal core: these
// tests cover only the translation from a Waffo refund event to the core's
// input, not the reversal math itself (covered in payment-reversal.test.ts).

function reversalRows(f: ReturnType<typeof createWaffoFixture>) {
  return f.store.ledgers.filter(
    (entry) => entry.operationType === "payment_reversal",
  );
}

test("a verified Waffo refund reverses the top-up once", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const before = f.store.account!.addOnCreditsBalance;
  const paid = signedEvent(f.event());
  await f.inbox.receive(paid.raw, paid.signature);
  await f.inbox.drain();
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    before + waffoConfig.catalog.creditTopupUnitAmount,
  );

  const refunded = signedEvent(f.refundEvent());
  await f.inbox.receive(refunded.raw, refunded.signature);
  await Promise.all([f.makeInbox().drain(), f.makeInbox().drain()]);
  assert.equal(f.store.account!.addOnCreditsBalance, before);
  assert.equal(reversalRows(f).length, 1);
  assert.equal(f.store.webhook?.status, "processed");
});

test("a partial Waffo refund reverses proportionally", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const before = f.store.account!.addOnCreditsBalance;
  const paid = signedEvent(f.event());
  await f.inbox.receive(paid.raw, paid.signature);
  await f.inbox.drain();
  const granted = waffoConfig.catalog.creditTopupUnitAmount;

  const refunded = signedEvent(
    f.refundEvent({ data: { refundedAmount: "5.00" } }),
  );
  await f.inbox.receive(refunded.raw, refunded.signature);
  await f.inbox.drain();
  const reversedUnits = Math.floor((granted * 500) / 1250);
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    before + granted - reversedUnits,
  );
  assert.equal(f.store.webhook?.status, "processed");
});

test("a refund delivered before order.completed nets to zero", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const before = f.store.account!.addOnCreditsBalance;

  const refunded = signedEvent(f.refundEvent());
  await f.inbox.receive(refunded.raw, refunded.signature);
  await f.inbox.drain();
  assert.equal(f.store.webhook?.status, "processed");

  const paid = signedEvent(f.event());
  await f.inbox.receive(paid.raw, paid.signature);
  await f.inbox.drain();
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(f.store.account!.addOnCreditsBalance, before);
});

test("refund.failed is ignored", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const paid = signedEvent(f.event());
  await f.inbox.receive(paid.raw, paid.signature);
  await f.inbox.drain();
  const before = f.store.account!.addOnCreditsBalance;

  const failed = signedEvent(f.refundEvent({ eventType: "refund.failed" }));
  await f.inbox.receive(failed.raw, failed.signature);
  await f.inbox.drain();
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "WAFFO_REFUND_FAILED");
  assert.equal(f.store.account!.addOnCreditsBalance, before);
});

test("a refund without amounts raises an alert and changes nothing", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const paid = signedEvent(f.event());
  await f.inbox.receive(paid.raw, paid.signature);
  await f.inbox.drain();
  const before = f.store.account!.addOnCreditsBalance;

  const unavailable = signedEvent(
    f.refundEvent({ data: { refundedAmount: undefined } }),
  );
  await f.inbox.receive(unavailable.raw, unavailable.signature);
  await f.inbox.drain();
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "WAFFO_REFUND_AMOUNT_UNAVAILABLE");
  assert.equal(f.store.account!.addOnCreditsBalance, before);
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey ===
        "billing:payment-reversal-amount-unavailable:waffo:RT_1",
    ),
  );
});

test("a refund whose order no longer exists is unmatched, not retried forever", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const missingOrderId = "missing-order-id";
  const refunded = signedEvent(
    f.refundEvent({
      data: {
        orderMerchantExternalId: missingOrderId,
        orderMetadata: { sourceweftOrderId: missingOrderId },
      },
    }),
  );
  await f.inbox.receive(refunded.raw, refunded.signature);
  await f.inbox.drain();
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "WAFFO_REFUND_UNMATCHED");
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey === "billing:payment-reversal-unmatched:waffo:RT_1",
    ),
  );
});

test("a refund missing its order reference is unmatched, not retried forever", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const refunded = signedEvent(
    f.refundEvent({ data: { orderMerchantExternalId: undefined } }),
  );
  await f.inbox.receive(refunded.raw, refunded.signature);
  await f.inbox.drain();
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "WAFFO_REFUND_UNMATCHED");
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey === "billing:payment-reversal-unmatched:waffo:RT_1",
    ),
  );
});

// A subscription renewal payment has no local SourceWeft order row, so a
// refund of one only ever resolves through Waffo's own order id, which
// doubles as the subscription's `externalSubscriptionId` (see
// `webhook.ts`'s `syncSubscriptionSnapshot` call, which stores it that way).
test("a Waffo renewal refund with no local order raises the subscription notice", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const now = new Date().toISOString();
  f.store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "waffo",
    planFamily: "individual_pro",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: now,
    externalCustomerId: null,
    // Matches `event().data.orderId`, which `refundEvent()` inherits.
    externalSubscriptionId: "ORD_2aUyqjCzEIiEcYMKj7TZtw",
    externalSubscriptionItemId: null,
    externalProductId: productId,
    billingOrderId: "order_sub_1",
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const before = f.store.account!.addOnCreditsBalance;

  const missingOrderId = "missing-order-id";
  const refunded = signedEvent(
    f.refundEvent({
      data: {
        orderMerchantExternalId: missingOrderId,
        orderMetadata: { sourceweftOrderId: missingOrderId },
      },
    }),
  );
  await f.inbox.receive(refunded.raw, refunded.signature);
  await f.inbox.drain();

  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "WAFFO_REFUND_SUBSCRIPTION_PAYMENT");
  // Never changes balances: the reversal core is never invoked for a
  // subscription-payment notice.
  assert.equal(f.store.account!.addOnCreditsBalance, before);
  const alert = f.alerts.find(
    (alert) =>
      alert.alertKey === "billing:subscription-payment-reversal:team_1",
  );
  assert.ok(alert);
  assert.equal(alert?.teamId, "team_1");
  assert.equal(alert?.metadata?.reason, "subscription_payment");
  assert.equal(alert?.metadata?.orderId, "order_sub_1");
});

test("a malformed refund amount raises an alert and changes nothing", async () => {
  const f = createWaffoFixture();
  await checkout(f);
  const paid = signedEvent(f.event());
  await f.inbox.receive(paid.raw, paid.signature);
  await f.inbox.drain();
  const before = f.store.account!.addOnCreditsBalance;

  const malformed = signedEvent(
    f.refundEvent({ data: { refundedAmount: "12,50" } }),
  );
  await f.inbox.receive(malformed.raw, malformed.signature);
  await f.inbox.drain();
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "WAFFO_REFUND_AMOUNT_UNAVAILABLE");
  assert.equal(f.store.account!.addOnCreditsBalance, before);
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey ===
        "billing:payment-reversal-amount-unavailable:waffo:RT_1",
    ),
  );
});

test("a refund after subscription.canceled is not dropped as stale", async () => {
  const f = createWaffoFixture();
  await f.billing.ensureBillingAccount("team_1", "user_1");
  await f.billing.createPricingCheckout(
    { plan: "pro", billingInterval: "monthly", source: "dashboard" },
    { userId: "user_1", email: "buyer@example.invalid" },
    { personalTeamId: "team_1" },
  );
  const active = f.event({ eventType: "subscription.activated" });
  Object.assign(active.data, {
    amount: "12.00",
    total: "12.00",
    orderStatus: "active",
    paymentId: undefined,
    paymentStatus: undefined,
    billingPeriod: "monthly",
    currentPeriodStart: "2026-09-01T00:00:00Z",
    currentPeriodEnd: "2026-10-01T00:00:00Z",
    productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
  });
  const activated = signedEvent(active);
  await f.inbox.receive(activated.raw, activated.signature);
  await f.inbox.drain();
  assert.equal(f.store.order?.status, "fulfilled");

  const canceled = {
    ...active,
    id: "subscription_cancel",
    eventType: "subscription.canceled",
    timestamp: new Date().toISOString(),
    data: { ...active.data, orderStatus: "canceled" },
  };
  const canceledDelivery = signedEvent(canceled);
  await f.inbox.receive(canceledDelivery.raw, canceledDelivery.signature);
  await f.inbox.drain();
  assert.equal(
    f.store.order?.metadata.waffoLastEventType,
    "subscription.canceled",
  );

  const refunded = signedEvent(f.refundEvent());
  await f.inbox.receive(refunded.raw, refunded.signature);
  await f.inbox.drain();
  assert.equal(f.store.webhook?.status, "processed");
  assert.ok(
    f.alerts.some((alert) =>
      alert.alertKey.startsWith("billing:subscription-payment-reversal:"),
    ),
  );
});

test("setup registers the refund events", () => {
  assert.ok(WAFFO_WEBHOOK_EVENTS.includes("refund.succeeded"));
  assert.ok(WAFFO_WEBHOOK_EVENTS.includes("refund.failed"));
});
