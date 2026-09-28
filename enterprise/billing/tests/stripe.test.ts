import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type Stripe from "stripe";
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
/** A one-time credit top-up paid and fulfilled through Checkout. */
async function fulfilledTopup(f: ReturnType<typeof stripeFixture>) {
  await topup(f);
  await deliver(f, f.event("checkout.session.completed", f.pay()));
  assert.equal(f.store.order!.status, "fulfilled");
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    stripeConfig.catalog.creditTopupUnitAmount,
  );
  return f.store.order!;
}
/** A Stripe charge (minor units, lowercase currency) of one credit top-up. */
function charge(
  paymentIntent: string,
  amountRefunded: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "ch_topup",
    object: "charge",
    amount: stripeConfig.catalog.creditTopupAmountCents,
    amount_refunded: amountRefunded,
    currency: "usd",
    payment_intent: paymentIntent,
    ...overrides,
  };
}
function dispute(paymentIntent: string, id: string, status: string) {
  return {
    id,
    object: "dispute",
    amount: stripeConfig.catalog.creditTopupAmountCents,
    currency: "usd",
    charge: "ch_topup",
    payment_intent: paymentIntent,
    status,
  };
}
/** Binds a PaymentIntent to the fixture's subscription invoice. */
function invoicePayment(
  f: ReturnType<typeof stripeFixture>,
  paymentIntent: string,
) {
  f.remote.paymentIntents.set(paymentIntent, {
    id: paymentIntent,
    object: "payment_intent",
    metadata: {},
  } as unknown as Stripe.PaymentIntent);
  f.remote.invoicePayments.push({
    id: `ip_${paymentIntent}`,
    object: "invoice_payment",
    invoice: f.remote.invoice!.id,
    payment: { type: "payment_intent", payment_intent: paymentIntent },
  } as unknown as Stripe.InvoicePayment);
}
const reversalRows = (f: ReturnType<typeof stripeFixture>) =>
  f.store.ledgers.filter((row) => row.operationType === "payment_reversal");

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
  assert.equal(call.body.get("managed_payments[enabled]"), "false");
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

test("a charge event resolves a one-time order by its payment intent", async () => {
  const f = stripeFixture();
  await topup(f);
  await deliver(f, f.event("checkout.session.completed", f.pay()));
  assert.equal(f.store.order!.status, "fulfilled");
  const paymentIntentId = f.store.order!.externalPaymentId!;
  await deliver(
    f,
    f.event("charge.refunded", charge(paymentIntentId, 1250, { id: "ch_1" })),
  );
  // Resolved locally and passed the order-binding check.
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.order!.reversalStatus, "refunded");
  assert.equal(
    f.requests.some((r) => r.path.startsWith("/v1/payment_intents/")),
    false,
  );
  assert.equal(
    f.requests.some((r) => r.path === "/v1/invoice_payments"),
    false,
  );
});

test("a charge event resolves through PaymentIntent metadata when the order has no payment id", async () => {
  const f = stripeFixture();
  await topup(f);
  assert.equal(f.store.order!.externalPaymentId, null);
  f.remote.paymentIntents.set("pi_recovered", {
    id: "pi_recovered",
    object: "payment_intent",
    metadata: { sourceweftOrderId: f.store.order!.id },
  } as unknown as Stripe.PaymentIntent);
  await deliver(
    f,
    f.event("charge.refunded", charge("pi_recovered", 1250, { id: "ch_2" })),
  );
  // Not fulfilled yet: the refund is recorded for fulfillment to reverse.
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.order!.reversalStatus, "refunded");
  assert.ok(
    f.requests.some((r) => r.path === "/v1/payment_intents/pi_recovered"),
  );
  assert.equal(
    f.requests.some((r) => r.path === "/v1/invoice_payments"),
    false,
  );
});

test("a charge event on a subscription invoice resolves to the subscription order", async () => {
  const f = stripeFixture();
  await subscription(f);
  f.pay();
  assert.equal(f.store.order!.kind, "subscription");
  invoicePayment(f, "pi_invoice");
  await deliver(
    f,
    f.event("charge.dispute.created", dispute("pi_invoice", "dp_1", "open")),
  );
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.webhook?.teamId, "team_1");
  assert.ok(
    f.alerts.some(
      (alert) => alert.alertKey === "billing:dispute-opened:stripe:dp_1",
    ),
  );
  assert.ok(
    f.requests.some((r) => r.path === "/v1/payment_intents/pi_invoice"),
  );
  assert.ok(f.requests.some((r) => r.path === "/v1/invoice_payments"));
});

test("an unresolvable charge event raises the unmatched alert and is ignored", async () => {
  const f = stripeFixture();
  f.remote.paymentIntents.set("pi_missing", {
    id: "pi_missing",
    object: "payment_intent",
    metadata: {},
  } as unknown as Stripe.PaymentIntent);
  await deliver(
    f,
    f.event("charge.dispute.created", {
      id: "dp_unmatched",
      object: "dispute",
      payment_intent: "pi_missing",
    }),
  );
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "STRIPE_UNRELATED_ORDER");
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey ===
        "billing:payment-reversal-unmatched:stripe:dp_unmatched",
    ),
  );
});

test("a 404 resource_missing while resolving a charge event is treated as not found and raises the unmatched alert", async () => {
  const f = stripeFixture();
  f.remote.paymentIntentError = {
    status: 404,
    type: "invalid_request_error",
    code: "resource_missing",
    message: "No such payment_intent: 'pi_gone'",
  };
  await deliver(
    f,
    f.event("charge.dispute.created", {
      id: "dp_404",
      object: "dispute",
      payment_intent: "pi_gone",
    }),
  );
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "STRIPE_UNRELATED_ORDER");
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey === "billing:payment-reversal-unmatched:stripe:dp_404",
    ),
  );
});

test("a 500 while resolving a charge event leaves the receipt failed for retry, without an unmatched alert", async () => {
  const f = stripeFixture();
  f.remote.paymentIntentError = {
    status: 500,
    type: "api_error",
    message: "Internal server error",
  };
  await deliver(
    f,
    f.event("charge.dispute.created", {
      id: "dp_500",
      object: "dispute",
      payment_intent: "pi_transient",
    }),
  );
  assert.equal(f.store.webhook?.status, "failed");
  assert.equal(f.store.webhook?.errorCode, "STRIPE_PROCESSING_FAILED");
  assert.equal(
    f.alerts.some((alert) =>
      alert.alertKey.startsWith("billing:payment-reversal-unmatched:"),
    ),
    false,
  );
});

test("charge.refunded reverses the top-up and redelivery is a no-op", async () => {
  const f = stripeFixture();
  const order = await fulfilledTopup(f);
  const paymentIntent = order.externalPaymentId!;
  const refunded = f.event(
    "charge.refunded",
    charge(paymentIntent, 1250),
    "evt_refunded",
  );
  await deliver(f, refunded);
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.account!.addOnCreditsBalance, 0);
  assert.equal(f.store.order!.reversalStatus, "refunded");
  assert.equal(f.store.order!.refundedAmount, 1250);
  assert.equal(f.store.order!.reversedUnits, 10000);

  // Stripe redelivers the same event; another event can carry the same
  // charge snapshot (same cumulative amount_refunded, same reversal id).
  await deliver(f, refunded);
  await deliver(f, f.event("charge.refunded", charge(paymentIntent, 1250)));
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(reversalRows(f).length, 1);
  // A refund that later fails lowers amount_refunded: nothing is re-granted.
  await deliver(f, f.event("charge.refunded", charge(paymentIntent, 500)));
  assert.equal(f.store.webhook?.status, "processed");

  assert.equal(f.store.account!.addOnCreditsBalance, 0);
  assert.equal(f.store.order!.reversalStatus, "refunded");
  assert.equal(f.store.order!.refundedAmount, 1250);
  assert.equal(f.store.order!.reversedUnits, 10000);
  assert.deepEqual(
    reversalRows(f).map((row) => [row.metadata.reversalId, row.delta]),
    [
      ["charge:ch_topup:refunded:1250", -10000],
      ["charge:ch_topup:refunded:500", 0],
    ],
  );
  const [debit] = reversalRows(f);
  assert.equal(debit!.feature, "payment_refund");
  assert.equal(debit!.activityTitle, "Credits top-up refunded");
  assert.deepEqual(debit!.metadata.providerMetadata, {
    chargeId: "ch_topup",
    paymentIntentId: paymentIntent,
  });
});

test("a partial charge.refunded reverses proportionally", async () => {
  const f = stripeFixture();
  const paymentIntent = (await fulfilledTopup(f)).externalPaymentId!;
  await deliver(f, f.event("charge.refunded", charge(paymentIntent, 500)));
  // 500 of 1250 cents refunded: floor(10000 * 500 / 1250) = 4000 credits.
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.account!.addOnCreditsBalance, 6000);
  assert.equal(f.store.order!.reversalStatus, "partially_refunded");
  assert.equal(f.store.order!.refundedAmount, 500);
  assert.equal(f.store.order!.reversedUnits, 4000);

  // amount_refunded is cumulative: 1000 of 1250 is 8000 in all, 4000 more.
  await deliver(f, f.event("charge.refunded", charge(paymentIntent, 1000)));
  assert.equal(f.store.account!.addOnCreditsBalance, 2000);
  assert.equal(f.store.order!.reversalStatus, "partially_refunded");
  assert.equal(f.store.order!.refundedAmount, 1000);
  assert.equal(f.store.order!.reversedUnits, 8000);
  assert.deepEqual(
    reversalRows(f).map((row) => row.delta),
    [-4000, -4000],
  );
});

test("an opened dispute only raises an alert", async () => {
  const f = stripeFixture();
  const order = await fulfilledTopup(f);
  await deliver(
    f,
    f.event(
      "charge.dispute.created",
      dispute(order.externalPaymentId!, "dp_open", "needs_response"),
    ),
  );
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    stripeConfig.catalog.creditTopupUnitAmount,
  );
  assert.equal(f.store.order!.reversalStatus, "none");
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) => entry.alertKey === "billing:dispute-opened:stripe:dp_open",
  );
  assert.equal(alert?.level, "warn");
  assert.equal(alert?.source, "billing.payment-reversal");
  assert.equal(alert?.teamId, "team_1");
  assert.equal(alert?.metadata?.orderId, order.id);
  assert.equal(alert?.metadata?.amount, 1250);
  assert.equal(alert?.metadata?.currency, "usd");
});

test("a lost dispute reverses in full, a won dispute changes nothing", async () => {
  const f = stripeFixture();
  const order = await fulfilledTopup(f);
  const paymentIntent = order.externalPaymentId!;
  await deliver(
    f,
    f.event("charge.dispute.closed", dispute(paymentIntent, "dp_won", "won")),
  );
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    stripeConfig.catalog.creditTopupUnitAmount,
  );
  assert.equal(f.store.order!.reversalStatus, "none");
  assert.equal(reversalRows(f).length, 0);

  const lost = f.event(
    "charge.dispute.closed",
    dispute(paymentIntent, "dp_lost", "lost"),
  );
  await deliver(f, lost);
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.account!.addOnCreditsBalance, 0);
  assert.equal(f.store.order!.reversalStatus, "charged_back");
  assert.equal(f.store.order!.reversedUnits, 10000);
  await deliver(f, f.event("charge.dispute.closed", lost.data.object));
  assert.equal(f.store.account!.addOnCreditsBalance, 0);
  const rows = reversalRows(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.metadata.reversalId, "dp_lost");
  assert.equal(rows[0]!.feature, "payment_chargeback");
  assert.equal(rows[0]!.activityTitle, "Credits top-up charged back");
  assert.equal(rows[0]!.delta, -10000);
});

test("a refund on a subscription invoice raises the subscription notice", async () => {
  const f = stripeFixture();
  await subscription(f);
  f.pay();
  await deliver(f, f.event("invoice.paid", f.remote.invoice));
  assert.equal(f.store.order!.status, "fulfilled");
  const balance = f.store.account!.monthlyCreditsBalance;
  invoicePayment(f, "pi_invoice");
  await deliver(
    f,
    f.event(
      "charge.refunded",
      charge("pi_invoice", 1200, { id: "ch_invoice", amount: 1200 }),
    ),
  );
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.account!.planFamily, "individual_pro");
  assert.equal(f.store.account!.monthlyCreditsBalance, balance);
  assert.equal(f.store.order!.reversalStatus, "none");
  assert.equal(reversalRows(f).length, 0);
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey === "billing:subscription-payment-reversal:team_1",
  );
  assert.equal(alert?.level, "error");
  assert.equal(alert?.metadata?.orderId, f.store.order!.id);
});

test("a charge.refunded the reversal core rejects is ignored with its own code", async () => {
  const f = stripeFixture();
  const order = await fulfilledTopup(f);
  await deliver(
    f,
    f.event(
      "charge.refunded",
      charge(order.externalPaymentId!, 1250, { currency: "eur" }),
    ),
  );
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "STRIPE_REVERSAL_REJECTED");
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    stripeConfig.catalog.creditTopupUnitAmount,
  );
  assert.ok(
    f.alerts.some(
      (alert) =>
        alert.alertKey === `billing:payment-reversal-rejected:${order.id}`,
    ),
  );
});

/**
 * Records a full refund on the stored order right after the webhook
 * handler's first, unlocked read of it — as a concurrently committed
 * reversal would — and hands the handler that stale pre-reversal snapshot.
 */
function reverseAfterFirstRead(f: ReturnType<typeof stripeFixture>) {
  const read = f.store.getOrderById.bind(f.store);
  let armed = true;
  f.store.getOrderById = async (id?: string) => {
    const row = await read(id);
    if (!armed || !row) return row;
    armed = false;
    const stale = structuredClone(row);
    const result = await f.billing.applyPaymentReversal({
      orderId: row.id,
      provider: "stripe",
      reversalId: "charge:ch_race:refunded:1250",
      kind: "refund",
      amount: { refundedTotal: 1250 },
      paidAmount: 1250,
      currency: "usd",
    });
    assert.equal(result.outcome, "recorded_before_fulfillment");
    return stale;
  };
}

test("recovering a missing checkout id keeps a reversal recorded after the handler read the order", async () => {
  const f = stripeFixture();
  await topup(f);
  const session = f.pay();
  f.store.order!.externalCheckoutId = null;
  reverseAfterFirstRead(f);
  await deliver(f, f.event("checkout.session.completed", session));
  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.order!.externalCheckoutId, session.id);
  assert.equal(f.store.order!.status, "fulfilled");
  assert.equal(f.store.order!.refundedAmount, 1250);
  assert.equal(f.store.order!.reversalStatus, "refunded");
  // Fulfillment applied the recorded refund, so the top-up nets to zero.
  assert.equal(f.store.order!.reversedUnits, 10000);
  assert.equal(f.store.account!.addOnCreditsBalance, 0);
});

test("expiring a checkout keeps a reversal recorded after the handler read the order", async () => {
  const f = stripeFixture();
  await topup(f);
  const session = f.remote.sessions.get(f.store.order!.externalCheckoutId!)!;
  session.status = "expired";
  reverseAfterFirstRead(f);
  await deliver(f, f.event("checkout.session.expired", session));
  assert.equal(f.store.order!.status, "expired");
  assert.equal(f.store.order!.paymentStatus, "expired");
  assert.equal(f.store.order!.refundedAmount, 1250);
  assert.equal(f.store.order!.reversalStatus, "refunded");
});

test("a charge event with no payment intent is unmatched and ignored", async () => {
  const f = stripeFixture();
  await deliver(
    f,
    f.event("charge.dispute.created", {
      ...dispute("", "dp_no_pi", "needs_response"),
      payment_intent: null,
    }),
  );
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "STRIPE_UNRELATED_ORDER");
  const alert = f.alerts.find(
    (entry) =>
      entry.alertKey === "billing:payment-reversal-unmatched:stripe:dp_no_pi",
  );
  assert.equal(alert?.level, "error");
  assert.equal(alert?.metadata?.amount, 1250);
  assert.equal(alert?.metadata?.currency, "usd");
  assert.equal(alert?.metadata?.eventType, "charge.dispute.created");
  assert.equal(alert?.metadata?.paymentIntentId, null);
  assert.equal(
    f.requests.some((r) => r.path.startsWith("/v1/payment_intents/")),
    false,
  );
});

test("a refund resolved to an order this deployment cannot use is unmatched, not retried", async () => {
  // A Stripe test account shared across environments: the PaymentIntent
  // names an order id this database does not hold.
  const foreign = stripeFixture();
  foreign.remote.paymentIntents.set("pi_foreign", {
    id: "pi_foreign",
    object: "payment_intent",
    metadata: { sourceweftOrderId: "order_elsewhere" },
  } as unknown as Stripe.PaymentIntent);
  await deliver(
    foreign,
    foreign.event(
      "charge.refunded",
      charge("pi_foreign", 500, { id: "ch_foreign" }),
    ),
  );
  assert.equal(foreign.store.webhook?.status, "ignored");
  assert.equal(foreign.store.webhook?.errorCode, "STRIPE_UNRELATED_ORDER");
  const alert = foreign.alerts.find(
    (entry) =>
      entry.alertKey === "billing:payment-reversal-unmatched:stripe:ch_foreign",
  );
  assert.equal(alert?.level, "error");
  assert.equal(alert?.metadata?.resolvedOrderId, "order_elsewhere");
  assert.equal(alert?.metadata?.paymentIntentId, "pi_foreign");
  assert.equal(alert?.metadata?.eventType, "charge.refunded");
  assert.equal(alert?.metadata?.amount, 1250);
  assert.equal(alert?.metadata?.amountRefunded, 500);
  assert.equal(alert?.metadata?.currency, "usd");

  // A local order bound to another Stripe account: the same, and no balance
  // change.
  const f = stripeFixture();
  const order = await fulfilledTopup(f);
  f.store.order!.metadata.stripeAccountId = "acct_other";
  await deliver(
    f,
    f.event(
      "charge.refunded",
      charge(order.externalPaymentId!, 1250, { id: "ch_other_account" }),
    ),
  );
  assert.equal(f.store.webhook?.status, "ignored");
  assert.equal(f.store.webhook?.errorCode, "STRIPE_UNRELATED_ORDER");
  assert.equal(
    f.store.account!.addOnCreditsBalance,
    stripeConfig.catalog.creditTopupUnitAmount,
  );
  assert.equal(f.store.order!.reversalStatus, "none");
  assert.equal(
    f.alerts.find(
      (entry) =>
        entry.alertKey ===
        "billing:payment-reversal-unmatched:stripe:ch_other_account",
    )?.metadata?.resolvedOrderId,
    order.id,
  );
});
