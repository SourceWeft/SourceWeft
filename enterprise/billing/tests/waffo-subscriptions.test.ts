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
      productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
    });
    delete charge.data.orderStatus;
    await deliver(f, charge);
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
    orderStatus: "active",
    billingPeriod: "monthly",
    productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
  });
  await deliver(f, event);
  assert.equal(f.store.webhook?.status, "failed");
  assert.equal(f.store.account?.planFamily, "individual_free");
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
