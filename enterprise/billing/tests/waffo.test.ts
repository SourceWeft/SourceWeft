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
import {
  createWaffoFixture,
  merchantId,
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
