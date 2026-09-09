import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createWaffoFixture, signedEvent, waffoConfig } from "./waffo-fixtures";
import { stripeFixture } from "./stripe-fixtures";
import { BillingService } from "../src/server/service";

async function waffoActive() {
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
    currentPeriodStart: "2026-09-01T00:00:00Z",
    currentPeriodEnd: "2026-10-01T00:00:00Z",
    productMetadata: { sourceweftProductKey: "individual_pro:monthly" },
  });
  const signed = signedEvent(event);
  await f.inbox.receive(signed.raw, signed.signature);
  await f.inbox.drain();
  assert.equal(f.store.subscription?.status, "active");
  return { f, event };
}
test("review: Waffo past_due with official expired paid period must record overdue status", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    const { f, event } = await waffoActive();
    vi.setSystemTime(new Date("2026-10-01T08:31:00Z"));
    const overdue = {
      ...event,
      id: "overdue",
      eventId: "overdue",
      eventType: "subscription.past_due",
      timestamp: new Date().toISOString(),
      data: { ...event.data, orderStatus: "past_due" },
    };
    const signed = signedEvent(overdue);
    await f.inbox.receive(signed.raw, signed.signature);
    await f.inbox.drain();
    console.log(
      "WAFFO_OVERDUE",
      f.store.webhook?.status,
      f.store.webhook?.errorCode,
      f.store.subscription?.status,
    );
    assert.equal(f.store.subscription?.status, "past_due");
  } finally {
    vi.useRealTimers();
  }
});
test("review: Waffo cancellation without optional period must revoke access", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    const { f, event } = await waffoActive();
    const canceled = {
      ...event,
      id: "canceled",
      eventId: "canceled",
      eventType: "subscription.canceled",
      data: { ...event.data, orderStatus: "canceled" },
    };
    delete canceled.data.currentPeriodStart;
    delete canceled.data.currentPeriodEnd;
    const signed = signedEvent(canceled);
    await f.inbox.receive(signed.raw, signed.signature);
    await f.inbox.drain();
    console.log(
      "WAFFO_CANCEL",
      f.store.webhook?.status,
      f.store.webhook?.errorCode,
      f.store.subscription?.status,
    );
    assert.equal(f.store.subscription?.status, "canceled");
  } finally {
    vi.useRealTimers();
  }
});
test("review: Stripe old subscription event must not overwrite replacement subscription", async () => {
  const f = stripeFixture();
  await f.billing.ensureBillingAccount("team_1", "user_1");
  await f.billing.createPricingCheckout(
    { plan: "pro", billingInterval: "monthly", source: "dashboard" },
    { userId: "user_1", email: "buyer@example.invalid" },
    { personalTeamId: "team_1" },
  );
  async function deliver(type: string, object: unknown) {
    const v = f.sign(f.event(type, object));
    await f.makeInbox().receive(v.raw, v.signature);
    await f.makeInbox().drain();
  }
  await deliver("checkout.session.completed", f.pay());
  assert.equal(f.store.subscription?.status, "active");
  f.remote.subscription!.status = "canceled";
  await deliver("customer.subscription.deleted", f.remote.subscription);
  assert.equal(f.store.subscription?.status, "canceled");
  const old = structuredClone(f.remote.subscription!);
  await f.billing.createPricingCheckout(
    { plan: "pro", billingInterval: "monthly", source: "dashboard" },
    { userId: "user_1", email: "buyer@example.invalid" },
    { personalTeamId: "team_1" },
  );
  const paid = f.pay();
  paid.subscription = "sub_replacement";
  f.remote.subscription!.id = "sub_replacement";
  await deliver("checkout.session.completed", paid);
  assert.equal(f.store.subscription?.externalSubscriptionId, "sub_replacement");
  f.remote.subscription = old;
  await deliver("customer.subscription.updated", old);
  console.log(
    "STRIPE_REPLACEMENT",
    f.store.subscription?.externalSubscriptionId,
    f.store.subscription?.status,
    f.store.account?.planFamily,
  );
  assert.equal(f.store.subscription?.externalSubscriptionId, "sub_replacement");
});
test.each(["waffo", "stripe"] as const)(
  "review: %s existing paid team must not be allowed to buy a second subscription",
  async (provider) => {
    const base =
      provider === "stripe"
        ? stripeFixture({ teamBillingEnabled: true })
        : createWaffoFixture();
    const f = {
      ...base,
      billing:
        provider === "stripe"
          ? base.billing
          : new BillingService(
              base.store,
              { ...waffoConfig, teamBillingEnabled: true },
              base.provider,
            ),
    };
    await f.billing.ensureBillingAccount("team_1", "user_1");
    await f.billing.syncSubscriptionSnapshot({
      teamId: "team_1",
      provider,
      planFamily: "team_standard",
      status: "active",
      confirmCoverage: true,
      billingInterval: "monthly",
      currentPeriodStart: new Date(Date.now() - 60000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
      externalCustomerId: "cus_existing",
      externalSubscriptionId: "sub_existing",
      externalProductId: "prod_existing",
      cancelAtPeriodEnd: false,
      seatCount: 2,
      metadata: {},
    });
    await assert.rejects(
      () =>
        f.billing.createSubscriptionCheckout(
          "team_1",
          {
            planFamily: "team_standard",
            billingInterval: "monthly",
            seatCount: 2,
          },
          { userId: "user_1", email: "buyer@example.invalid" },
        ),
      /already active/i,
    );
  },
);
