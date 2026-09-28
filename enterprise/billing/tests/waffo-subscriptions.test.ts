import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { WebhookEvent } from "@waffo/pancake-ts";
import { createWaffoFixture, signedEvent } from "./waffo-fixtures";

async function deliver(
  f: ReturnType<typeof createWaffoFixture>,
  event: WebhookEvent,
) {
  const signed = signedEvent(event);
  await f.inbox.receive(signed.raw, signed.signature);
  await f.inbox.drain();
}
test("subscription domain events own renewal; duplicate and stale events do not restore credits or canceled access", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    const f = createWaffoFixture();
    await f.billing.ensureBillingAccount("team_1", "user_1");
    await f.billing.createPricingCheckout(
      { plan: "pro", billingInterval: "monthly", source: "dashboard" },
      { userId: "user_1", email: "buyer@example.invalid" },
      { personalTeamId: "team_1" },
    );
    const active = f.event({
      id: "subscription_delivery",
      eventType: "subscription.activated",
    });
    Object.assign(active.data, {
      amount: "12.00",
      total: "12.00",
      planPrice: { total: "12.00", subtotal: "12.00", taxAmount: "0.00" },
      orderStatus: "active",
      paymentId: undefined,
      paymentStatus: undefined,
      billingPeriod: "monthly",
      currentPeriodStart: "2026-09-01T00:00:00Z",
      currentPeriodEnd: "2026-10-01T00:00:00Z",
      productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
    });
    await deliver(f, active);
    assert.equal(f.store.order?.status, "fulfilled");
    assert.equal(f.store.account?.planFamily, "individual_pro");
    await f.billing.meterConsume(
      "team_1",
      {
        credits: 10,
        feature: "test",
        idempotencyKey: "spend-after-activation",
      },
      "user_1",
    );
    const spentBalance = f.store.account!.monthlyCreditsBalance;
    await deliver(f, active);
    assert.equal(f.store.account!.monthlyCreditsBalance, spentBalance);

    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const charge = f.event({
      id: "renewal_payment",
      eventType: "subscription.payment_succeeded",
    });
    Object.assign(charge.data, {
      amount: "12.00",
      total: "12.00",
      listPrice: { total: "12.00", subtotal: "12.00", taxAmount: "0.00" },
      productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
    });
    delete charge.data.orderStatus;
    await deliver(f, charge);
    // The charge grants nothing, so the balance alone cannot show it was
    // verified; the receipt status proves its listPrice was read.
    assert.equal(f.store.webhook?.status, "processed");
    assert.equal(f.store.account!.monthlyCreditsBalance, spentBalance);
    const renewed = {
      ...active,
      eventType: "subscription.renewed",
      timestamp: new Date().toISOString(),
      data: {
        ...active.data,
        currentPeriodStart: "2026-10-01T00:00:00Z",
        currentPeriodEnd: "2026-11-01T00:00:00Z",
      },
    };
    await deliver(f, renewed);
    assert.equal(
      f.store.subscription?.currentPeriodEnd,
      "2026-11-01T00:00:00Z",
    );
    assert.ok(f.store.account!.monthlyCreditsBalance > spentBalance);

    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    const canceled = {
      ...renewed,
      eventType: "subscription.canceled",
      timestamp: new Date().toISOString(),
      data: { ...renewed.data, orderStatus: "canceled" },
    };
    await deliver(f, canceled);
    assert.equal(f.store.subscription?.status, "canceled");
    assert.equal(f.store.account?.planFamily, "individual_free");
    await deliver(f, { ...active, id: "late_activation" });
    assert.equal(f.store.subscription?.status, "canceled");
    assert.equal(f.store.account?.planFamily, "individual_free");
  } finally {
    vi.useRealTimers();
  }
});

test("a signed subscription event without a provider period never fabricates a billing cycle", async () => {
  const f = createWaffoFixture();
  await f.billing.ensureBillingAccount("team_1", "user_1");
  await f.billing.createPricingCheckout(
    { plan: "pro", billingInterval: "monthly", source: "dashboard" },
    { userId: "user_1", email: "buyer@example.invalid" },
    { personalTeamId: "team_1" },
  );
  const event = f.event({ eventType: "subscription.activated" });
  Object.assign(event.data, {
    amount: "12.00",
    total: "12.00",
    planPrice: { total: "12.00", subtotal: "12.00", taxAmount: "0.00" },
    orderStatus: "active",
    billingPeriod: "monthly",
    productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
  });
  await deliver(f, event);
  assert.equal(f.store.webhook?.status, "failed");
  assert.equal(f.store.account?.planFamily, "individual_free");
  assert.equal(f.store.order?.paymentStatus, "unpaid");
});

test("subscription status events verify the plan price, not the deprecated total", async () => {
  for (const [planTotal, expectedStatus] of [
    ["12.00", "processed"],
    ["1.00", "failed"],
  ] as const) {
    const f = createWaffoFixture();
    await f.billing.ensureBillingAccount("team_1", "user_1");
    await f.billing.createPricingCheckout(
      { plan: "pro", billingInterval: "monthly", source: "dashboard" },
      { userId: "user_1", email: "buyer@example.invalid" },
      { personalTeamId: "team_1" },
    );
    const event = f.event({ eventType: "subscription.activated" });
    Object.assign(event.data, {
      // The deprecated generic amounts disagree with the checkout on purpose:
      // only `planPrice` may decide a subscription status event.
      amount: "99.00",
      total: "99.00",
      planPrice: { total: planTotal, subtotal: planTotal, taxAmount: "0.00" },
      orderStatus: "active",
      paymentId: undefined,
      paymentStatus: undefined,
      billingPeriod: "monthly",
      currentPeriodStart: "2026-09-01T00:00:00Z",
      currentPeriodEnd: "2026-10-01T00:00:00Z",
      productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
    });
    delete event.data.listPrice;
    await deliver(f, event);
    assert.equal(f.store.webhook?.status, expectedStatus);
    assert.equal(
      f.store.order?.paymentStatus,
      expectedStatus === "processed" ? "paid" : "unpaid",
    );
  }
});

test("a subscription status event without a plan price fails without falling back to the deprecated total", async () => {
  const f = createWaffoFixture();
  await f.billing.ensureBillingAccount("team_1", "user_1");
  await f.billing.createPricingCheckout(
    { plan: "pro", billingInterval: "monthly", source: "dashboard" },
    { userId: "user_1", email: "buyer@example.invalid" },
    { personalTeamId: "team_1" },
  );
  const event = f.event({ eventType: "subscription.activated" });
  Object.assign(event.data, {
    // The deprecated amounts match the checkout, so only a fallback to them
    // could make this pass; the error code pins "no fallback".
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
  delete event.data.listPrice;
  delete event.data.planPrice;
  await deliver(f, event);
  assert.equal(f.store.webhook?.status, "failed");
  assert.equal(f.store.webhook?.errorCode, "WAFFO_AMOUNT_UNAVAILABLE");
  assert.equal(f.store.order?.paymentStatus, "unpaid");
});

test("canceling delivered before activation establishes the paid order and keeps scheduled cancellation", async () => {
  const f = createWaffoFixture();
  await f.billing.ensureBillingAccount("team_1", "user_1");
  await f.billing.createPricingCheckout(
    { plan: "pro", billingInterval: "monthly", source: "dashboard" },
    { userId: "user_1", email: "buyer@example.invalid" },
    { personalTeamId: "team_1" },
  );
  const event = f.event({ eventType: "subscription.canceling" });
  Object.assign(event.data, {
    amount: "12.00",
    total: "12.00",
    planPrice: { total: "12.00", subtotal: "12.00", taxAmount: "0.00" },
    orderStatus: "canceling",
    billingPeriod: "monthly",
    currentPeriodStart: new Date(Date.now() - 60_000).toISOString(),
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
  });
  await deliver(f, event);
  assert.equal(f.store.order?.paymentStatus, "paid");
  assert.equal(f.store.order?.status, "fulfilled");
  assert.equal(f.store.subscription?.cancelAtPeriodEnd, true);
  const balance = f.store.account!.monthlyCreditsBalance;
  await deliver(f, {
    ...event,
    id: "late_activation",
    eventType: "subscription.activated",
    timestamp: new Date(Date.parse(event.timestamp) - 10_000).toISOString(),
    data: { ...event.data, orderStatus: "active" },
  });
  assert.equal(f.store.subscription?.cancelAtPeriodEnd, true);
  assert.equal(f.store.account!.monthlyCreditsBalance, balance);
});

test("a subscription event's metadata write keeps reversal fields committed under the order's row lock", async () => {
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
    planPrice: { total: "12.00", subtotal: "12.00", taxAmount: "0.00" },
    orderStatus: "active",
    billingPeriod: "monthly",
    currentPeriodStart: "2026-09-01T00:00:00Z",
    currentPeriodEnd: "2026-10-01T00:00:00Z",
    productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
  });
  await deliver(f, active);
  assert.equal(f.store.order?.status, "fulfilled");

  // Simulate a refund that committed refundedAmount / reversalStatus and
  // metadata.reversalPaidAmount onto the order row under its own row lock,
  // while the unlocked `getOrderById` still serves the pre-reversal
  // snapshot -- exactly what a real, concurrently committed reversal looks
  // like to any reader that is not holding the row lock.
  f.store.order = {
    ...f.store.order!,
    refundedAmount: 500,
    reversedUnits: 5_000,
    reversalStatus: "refunded",
    metadata: { ...f.store.order!.metadata, reversalPaidAmount: 1200 },
  };
  f.store.orders.set(f.store.order.id, f.store.order);
  const trueRead = f.store.getOrderById.bind(f.store);
  f.store.getOrderById = async (id?: string) => {
    const fresh = await trueRead(id);
    if (!fresh) return fresh;
    const staleMetadata = { ...fresh.metadata };
    delete staleMetadata.reversalPaidAmount;
    return {
      ...fresh,
      refundedAmount: 0,
      reversedUnits: 0,
      reversalStatus: "none" as const,
      metadata: staleMetadata,
    };
  };
  f.store.getOrderByIdForUpdate = async (id?: string) => trueRead(id);

  const overdue = {
    ...active,
    id: "overdue",
    eventId: "overdue",
    eventType: "subscription.past_due",
    timestamp: new Date().toISOString(),
    data: { ...active.data, orderStatus: "past_due" },
  };
  await deliver(f, overdue);

  assert.equal(f.store.webhook?.status, "processed");
  assert.equal(f.store.order?.refundedAmount, 500);
  assert.equal(f.store.order?.reversedUnits, 5_000);
  assert.equal(f.store.order?.reversalStatus, "refunded");
  assert.equal(f.store.order?.metadata.reversalPaidAmount, 1200);
  assert.equal(
    f.store.order?.metadata.waffoLastEventType,
    "subscription.past_due",
  );
});
