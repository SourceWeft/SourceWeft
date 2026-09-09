import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { Hono } from "hono";
import {
  readBillingConfig,
  validateBillingConfiguration,
} from "../src/server/config";
import { registerStripeWebhook } from "../src/integrations/stripe";
import { stripeFixture, stripeConfig } from "./stripe-fixtures";
import { BillingService } from "../src/server/service";
import { StripeBillingProvider } from "../src/server/providers/stripe/provider";

async function topup(
  f: ReturnType<typeof stripeFixture>,
  reference = "test-topup",
) {
  await f.billing.ensureBillingAccount("team_1", "user_1");
  return f.billing.createTopupCheckout(
    "team_1",
    { unitType: "credit", quantity: 1, clientReferenceKey: reference },
    "user_1",
    "buyer@example.invalid",
  );
}
async function subscription(f: ReturnType<typeof stripeFixture>) {
  await f.billing.ensureBillingAccount("team_1", "user_1");
  return f.billing.createPricingCheckout(
    {
      plan: "pro",
      billingInterval: "monthly",
      source: "dashboard",
      clientReferenceKey: "test-sub",
    },
    { userId: "user_1", email: "buyer@example.invalid" },
    { personalTeamId: "team_1" },
  );
}
async function deliver(
  f: ReturnType<typeof stripeFixture>,
  event: ReturnType<ReturnType<typeof stripeFixture>["event"]>,
) {
  const value = f.sign(event);
  await f.makeInbox().receive(value.raw, value.signature);
  await f.makeInbox().drain();
}

test("Stripe activation is explicit and rejects public keys, wrong modes and missing webhook secrets", () => {
  assert.equal(
    readBillingConfig(
      {
        STRIPE_SECRET_KEY: "sk_test_fixture",
        STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      },
      "http://localhost",
    ).provider,
    "none",
  );
  const config = readBillingConfig(
    {
      SOURCEWEFT_SAAS_ENABLED: "true",
      BACKEND_BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    },
    "http://localhost",
  );
  validateBillingConfiguration(config);
  assert.equal(config.stripe.testMode, true);
  for (const key of ["pk_test_bad", "sk_live_wrong"])
    assert.throws(
      () =>
        validateBillingConfiguration({
          ...config,
          stripe: { ...config.stripe, secretKey: key },
        }),
      /STRIPE_SECRET_KEY/,
    );
  assert.throws(
    () =>
      validateBillingConfiguration({
        ...config,
        stripe: { ...config.stripe, webhookSecret: "" },
      }),
    /STRIPE_WEBHOOK_SECRET/,
  );
});

test("official SDK creates server-priced Checkout with metadata and stable idempotency", async () => {
  const f = stripeFixture();
  const result = await topup(f);
  assert.equal(result.provider, "stripe");
  const call = f.requests.find((r) => r.path === "/v1/checkout/sessions")!;
  assert.equal(call.body.get("line_items[0][price_data][unit_amount]"), "1250");
  assert.equal(call.body.get("mode"), "payment");
  assert.equal(call.body.get("adaptive_pricing[enabled]"), "false");
  assert.equal(call.body.get("client_reference_id"), result.orderId);
  assert.equal(call.body.get("metadata[sourceweftAccountId]"), "acct_fixture");
  assert.equal(
    call.headers.get("idempotency-key"),
    `sourceweft-checkout:${result.orderId}:initial`,
  );
  assert.equal(f.store.order?.metadata.stripeTestMode, true);
  assert.equal((await topup(f)).orderId, result.orderId);
  assert.equal(
    f.requests.filter((r) => r.path === "/v1/checkout/sessions").length,
    1,
  );
});

test("unpaid Checkout grants nothing; delayed payment and duplicate events grant once after restart", async () => {
  const f = stripeFixture();
  await topup(f);
  const session = [...f.remote.sessions.values()][0]!;
  session.status = "complete";
  await deliver(f, f.event("checkout.session.completed", session));
  assert.equal(f.store.account!.addOnCreditsBalance, 0);
  f.pay();
  const event = f.event(
    "checkout.session.async_payment_succeeded",
    session,
    "evt_paid",
  );
  const signed = f.sign(event);
  await f.makeInbox().receive(signed.raw, signed.signature);
  assert.equal(f.store.account!.addOnCreditsBalance, 0);
  await Promise.all([f.makeInbox().drain(), f.makeInbox().drain()]);
  assert.equal(f.store.order!.status, "fulfilled");
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    stripeConfig.catalog.creditTopupUnitAmount,
  );
  await deliver(f, event);
  await deliver(f, f.event("checkout.session.completed", session));
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    stripeConfig.catalog.creditTopupUnitAmount,
  );
});

test("Stripe webhook rejects tampered, stale, live and Connect deliveries", async () => {
  const f = stripeFixture();
  await topup(f);
  const event = f.event("checkout.session.completed", f.pay());
  const app = new Hono();
  registerStripeWebhook(app, f.makeInbox());
  const valid = f.sign(event);
  const cases = [
    { raw: valid.raw + " ", signature: valid.signature, expected: 401 },
    { ...f.sign(event, Math.floor(Date.now() / 1000) - 600), expected: 401 },
    { ...f.sign({ ...event, livemode: true }), expected: 403 },
    { ...f.sign({ ...event, account: "acct_connected" }), expected: 403 },
  ];
  for (const value of cases) {
    const response = await app.request("/v1/billing/webhooks/stripe", {
      method: "POST",
      body: value.raw,
      headers: { "stripe-signature": value.signature },
    });
    assert.equal(response.status, value.expected);
  }
  assert.equal(f.store.webhooks.size, 0);
  const accepted = await app.request("/v1/billing/webhooks/stripe", {
    method: "POST",
    body: valid.raw,
    headers: { "stripe-signature": valid.signature },
  });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "OK");
  await f.makeInbox().drain();
  assert.equal(f.store.order?.status, "fulfilled");
});

test("wrong amounts and unrelated checkout sessions never grant credit", async () => {
  for (const change of ["amount", "session", "account"]) {
    const f = stripeFixture();
    await topup(f);
    const session = f.pay();
    if (change === "amount") session.amount_total = 100;
    if (change === "session") session.client_reference_id = "other-order";
    if (change === "account")
      f.store.order!.metadata.stripeAccountId = "acct_other";
    await deliver(f, f.event("checkout.session.completed", session));
    assert.equal(f.store.account!.addOnCreditsBalance, 0);
    assert.equal(f.store.webhook?.status, "failed");
  }
});

test("invoice.paid can arrive first and stale events cannot revive a canceled subscription", async () => {
  const f = stripeFixture();
  await subscription(f);
  f.pay();
  await deliver(f, f.event("invoice.paid", f.remote.invoice));
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(f.store.account?.planFamily, "individual_pro");
  await f.billing.meterConsume(
    "team_1",
    { credits: 10, feature: "test", idempotencyKey: "spent" },
    "user_1",
  );
  const balance = f.store.account!.monthlyCreditsBalance;
  await deliver(
    f,
    f.event("customer.subscription.updated", f.remote.subscription),
  );
  assert.equal(f.store.account!.monthlyCreditsBalance, balance);
  const oldSnapshot = JSON.parse(JSON.stringify(f.remote.subscription));
  f.remote.subscription!.status = "canceled";
  await deliver(
    f,
    f.event("customer.subscription.deleted", f.remote.subscription),
  );
  assert.equal(f.store.account?.planFamily, "individual_free");
  await deliver(f, f.event("customer.subscription.updated", oldSnapshot));
  assert.equal(f.store.account?.planFamily, "individual_free");
  assert.equal(f.store.subscription?.status, "canceled");
});

test("an unpaid latest invoice cannot increase quota or renew a subscription", async () => {
  const f = stripeFixture();
  await subscription(f);
  f.pay();
  f.remote.invoice!.status = "open";
  await deliver(
    f,
    f.event("customer.subscription.updated", f.remote.subscription),
  );
  assert.equal(f.store.order?.paymentStatus, "unpaid");
  assert.equal(f.store.account?.planFamily, "individual_free");
});

test("Stripe account switch does not reuse another account's pending checkout", async () => {
  const f = stripeFixture();
  const first = await topup(f);
  f.remote.accountId = "acct_other";
  const billing = new BillingService(
    f.store,
    stripeConfig,
    new StripeBillingProvider(stripeConfig, f.client),
  );
  const second = await billing.createTopupCheckout(
    "team_1",
    { unitType: "credit", quantity: 1, clientReferenceKey: "test-topup" },
    "user_1",
    "buyer@example.invalid",
  );
  assert.notEqual(second.orderId, first.orderId);
  assert.notEqual(second.checkoutUrl, first.checkoutUrl);
});

test("portal uses bound customer and seat changes require successful immediate payment", async () => {
  const f = stripeFixture({ teamBillingEnabled: true });
  await f.billing.createPricingCheckout(
    {
      plan: "team",
      billingInterval: "monthly",
      source: "dashboard",
      seatCount: 2,
    },
    { userId: "user_1", email: "buyer@example.invalid" },
  );
  f.pay();
  const portal = await f.provider.createPortal({
    teamId: "team_1",
    actorUserId: "user_1",
    externalSubscriptionId: "sub_fixture",
  });
  assert.match(portal.portalUrl, /billing.stripe.com/);
  assert.equal(
    f.requests
      .find((r) => r.path === "/v1/billing_portal/sessions")!
      .body.get("return_url"),
    "http://localhost:3000/dashboard",
  );
  f.remote.rejectSeatPayment = true;
  await assert.rejects(
    f.provider.updateSubscriptionSeats({
      teamId: "team_1",
      externalSubscriptionId: "sub_fixture",
      seatCount: 3,
      updateBehavior: "proration-charge-immediately",
    }),
  );
  const failed = f.requests.find(
    (r) => r.path === "/v1/subscriptions/sub_fixture" && r.method === "POST",
  )!;
  assert.equal(failed.body.get("payment_behavior"), "error_if_incomplete");
  assert.equal(failed.body.get("proration_behavior"), "always_invoice");
  assert.equal(f.remote.subscription!.items.data[0]!.quantity, 2);
  f.remote.rejectSeatPayment = false;
  const updated = await f.provider.updateSubscriptionSeats({
    teamId: "team_1",
    externalSubscriptionId: "sub_fixture",
    seatCount: 3,
    updateBehavior: "proration-charge-immediately",
  });
  assert.equal(updated.seatCount, 3);
});

test("a paid renewal advances the period once and repeated invoice notifications do not refill spent credits", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    const f = stripeFixture();
    await subscription(f);
    f.pay();
    await deliver(f, f.event("invoice.paid", f.remote.invoice));
    await f.billing.meterConsume(
      "team_1",
      { credits: 10, feature: "test", idempotencyKey: "before-renewal" },
      "user_1",
    );
    const oldBalance = f.store.account!.monthlyCreditsBalance;
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    const item = f.remote.subscription!.items.data[0]!;
    item.current_period_start = Math.floor(Date.now() / 1000) - 60;
    item.current_period_end = Math.floor(Date.now() / 1000) + 30 * 86400;
    f.remote.invoice!.id = "in_renewal";
    await deliver(f, f.event("invoice.paid", f.remote.invoice));
    assert.ok(f.store.account!.monthlyCreditsBalance > oldBalance);
    await f.billing.meterConsume(
      "team_1",
      { credits: 10, feature: "test", idempotencyKey: "after-renewal" },
      "user_1",
    );
    const spent = f.store.account!.monthlyCreditsBalance;
    await deliver(f, f.event("invoice.paid", f.remote.invoice));
    assert.equal(f.store.account!.monthlyCreditsBalance, spent);
  } finally {
    vi.useRealTimers();
  }
});

test("expired Stripe checkout refresh uses a new idempotency key and the original local order", async () => {
  const f = stripeFixture();
  const first = await topup(f);
  const oldId = f.store.order!.externalCheckoutId!;
  const session = f.remote.sessions.get(oldId)!;
  session.status = "expired";
  await deliver(f, f.event("checkout.session.expired", session));
  assert.equal(f.store.order!.status, "expired");
  const second = await topup(f);
  assert.equal(first.orderId, second.orderId);
  assert.notEqual(first.checkoutUrl, second.checkoutUrl);
  const calls = f.requests.filter((r) => r.path === "/v1/checkout/sessions");
  assert.equal(
    calls[1]!.headers.get("idempotency-key"),
    `sourceweft-checkout:${first.orderId}:${oldId}`,
  );
  await deliver(f, f.event("checkout.session.expired", session));
  assert.equal(f.store.order!.status, "checkout_created");
  assert.equal(f.store.webhook!.status, "ignored");
});

test("a processing failure remains durable and succeeds after recovery", async () => {
  const f = stripeFixture();
  await topup(f);
  const event = f.event("checkout.session.completed", f.pay());
  const fulfill = f.billing.fulfillOrder.bind(f.billing);
  f.billing.fulfillOrder = async () => {
    throw new Error("transient database failure");
  };
  await deliver(f, event);
  assert.equal(f.store.webhook?.status, "failed");
  f.billing.fulfillOrder = fulfill;
  await f.makeInbox().drain();
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.order?.status, "fulfilled");
});

test("failed renewal records past-due status without advancing the paid period or replenishing credits", async () => {
  const f = stripeFixture();
  await subscription(f);
  f.pay();
  await deliver(f, f.event("invoice.paid", f.remote.invoice));
  await f.billing.meterConsume(
    "team_1",
    { credits: 10, feature: "test", idempotencyKey: "before-failed-renewal" },
    "user_1",
  );
  const balance = f.store.account!.monthlyCreditsBalance;
  const paidEnd = f.store.subscription!.currentPeriodEnd;
  f.remote.subscription!.status = "past_due";
  f.remote.invoice!.status = "open";
  f.remote.invoice!.id = "in_unpaid";
  f.remote.subscription!.items.data[0]!.current_period_end += 30 * 86400;
  await deliver(f, f.event("invoice.payment_failed", f.remote.invoice));
  assert.equal(f.store.subscription!.status, "past_due");
  assert.equal(f.store.subscription!.currentPeriodEnd, paidEnd);
  assert.equal(f.store.account!.monthlyCreditsBalance, balance);
});
