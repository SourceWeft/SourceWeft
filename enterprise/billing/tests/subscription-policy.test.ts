import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { BillingService } from "../src/server/service";
import { createBillingAuthPlugins } from "../src/integrations/auth";
import {
  MemoryBillingStore,
  runtimeConfig,
  noopProvider,
} from "./test-fixtures";
import { stripeFixture } from "./stripe-fixtures";
import { createWaffoFixture } from "./waffo-fixtures";
import { normalizeSubscriptionFact } from "../src/server/subscription-policy";
import { createActiveTeamSubscription } from "./test-fixtures";

test("a different plan can replace checkout only after authoritative expiry", async () => {
  const f = stripeFixture();
  await f.billing.ensureBillingAccount("team_1", "user_1");
  const create = (billingInterval: "monthly" | "yearly") =>
    f.billing.createPricingCheckout(
      {
        plan: "pro",
        billingInterval,
        source: "dashboard",
      },
      { userId: "user_1", email: "buyer@example.invalid" },
      { personalTeamId: "team_1" },
    );
  const initial = await create("monthly");
  await assert.rejects(
    () => create("yearly"),
    (error: any) => error.code === "SUBSCRIPTION_OPERATION_CONFLICT",
  );
  f.remote.sessions.get(f.store.order!.externalCheckoutId!)!.status = "expired";
  const replacement = await create("yearly");
  assert.notEqual(replacement.orderId, initial.orderId);
  assert.equal(f.store.order?.billingInterval, "yearly");
});

test("late paid confirmation cannot undo a newer cancellation intent", () => {
  const current = createActiveTeamSubscription();
  current.cancelAtPeriodEnd = true;
  current.metadata.subscriptionStateAt = "2026-09-09T00:02:00Z";
  const snapshot = normalizeSubscriptionFact(
    current,
    {
      ...current,
      seatCount: 2,
      status: "active",
      cancelAtPeriodEnd: false,
      confirmCoverage: true,
      eventOccurredAt: "2026-09-09T00:01:00Z",
    },
    false,
  );
  assert.equal(snapshot?.cancelAtPeriodEnd, true);
  assert.equal(snapshot?.confirmedPeriodEnd, current.currentPeriodEnd);
});

test("Waffo timeout recovery keeps the same SDK idempotency key beyond its default minute", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    const f = createWaffoFixture();
    await f.billing.ensureBillingAccount("team_1", "user_1");
    const original = f.provider.createCheckout.bind(f.provider);
    let fail = true;
    f.provider.createCheckout = async (input) => {
      const result = await original(input);
      if (fail) throw new Error("response lost after Waffo accepted checkout");
      return result;
    };
    const create = () =>
      f.billing.createPricingCheckout(
        { plan: "pro", billingInterval: "monthly", source: "dashboard" },
        { userId: "user_1", email: "buyer@example.invalid" },
        { personalTeamId: "team_1" },
      );
    await assert.rejects(create);
    const orderId = f.store.order!.id;
    vi.setSystemTime(new Date("2026-09-09T00:02:00Z"));
    fail = false;
    const result = await create();
    assert.equal(result.orderId, orderId);
    assert.equal(f.requests.length, 2);
    assert.equal(
      f.requests[0]!.headers.get("x-idempotency-key"),
      f.requests[1]!.headers.get("x-idempotency-key"),
    );
    assert.deepEqual(f.requests[0]!.body, f.requests[1]!.body);
  } finally {
    vi.useRealTimers();
  }
});

test("Creem uses common storage and does not expose provider checkout or management bypasses", () => {
  const plugins = createBillingAuthPlugins({
    mode: "runtime",
    config: {
      ...runtimeConfig,
      provider: "creem",
      creem: {
        ...runtimeConfig.creem,
        apiKey: "creem_test_fixture",
        webhookSecret: "fixture",
      },
    },
    sync: async () => {},
  });
  assert.deepEqual(plugins[0]?.schema, {});
  assert.deepEqual(Object.keys(plugins[0]!.endpoints), ["creemWebhook"]);
});

test("manual subscriptions expire locally without payment credentials and retain top-up credits", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    const store = new MemoryBillingStore();
    const billing = new BillingService(store, runtimeConfig, noopProvider);
    await billing.ensureBillingAccount("team_1", "user_1");
    await billing.syncSubscriptionSnapshot({
      teamId: "team_1",
      provider: "manual",
      planFamily: "individual_pro",
      status: "active",
      confirmCoverage: true,
      billingInterval: "monthly",
      currentPeriodStart: "2026-09-01T00:00:00Z",
      currentPeriodEnd: "2026-10-01T00:00:00Z",
      externalCustomerId: null,
      externalSubscriptionId: null,
      externalProductId: null,
      cancelAtPeriodEnd: false,
      seatCount: 1,
      metadata: { authorizedBy: "operator", reason: "Contract grant" },
    });
    assert.equal(store.account?.cycleSource, "manual");
    store.account!.addOnCreditsBalance = 321;
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    await billing.getSummary("team_1", "user_1");
    assert.equal(store.account?.planFamily, "individual_free");
    assert.equal(store.account?.addOnCreditsBalance, 321);
    const count = store.ledgers.length;
    await billing.getSummary("team_1", "user_1");
    assert.equal(store.ledgers.length, count);
  } finally {
    vi.useRealTimers();
  }
});

test("Stripe receipt recovers checkout result lost before local persistence", async () => {
  const f = stripeFixture();
  await f.billing.ensureBillingAccount("team_1", "user_1");
  const original = f.provider.createCheckout.bind(f.provider);
  let lostSession: string | undefined;
  f.provider.createCheckout = async (input) => {
    const result = await original(input);
    lostSession = result.externalCheckoutId!;
    throw new Error("connection closed after provider commit");
  };
  await assert.rejects(() =>
    f.billing.createPricingCheckout(
      { plan: "pro", billingInterval: "monthly", source: "dashboard" },
      { userId: "user_1", email: "buyer@example.invalid" },
      { personalTeamId: "team_1" },
    ),
  );
  assert.equal(f.store.order!.externalCheckoutId, null);
  const event = f.event("checkout.session.completed", f.pay(lostSession));
  const signed = f.sign(event);
  const inbox = f.makeInbox();
  await inbox.receive(signed.raw, signed.signature);
  await inbox.drain();
  assert.equal(f.store.order!.status, "fulfilled");
  assert.equal([...f.store.operations.values()][0]!.status, "succeeded");
});
