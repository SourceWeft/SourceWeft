import assert from "node:assert/strict";
import { test } from "vitest";
import { createCreemSubscriptionSync } from "../src/server/providers/creem-subscription-sync";
import { BillingService } from "../src/server/service";
import {
  runtimeConfig,
  MemoryBillingStore,
  noopProvider,
} from "./test-fixtures";

test("webhook with active snapshot without usable period is ignored without retry failure", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );

  const result = await billingService.processSubscriptionWebhookEvent({
    provider: "creem",
    providerEventId: "evt_missing_period",
    eventType: "subscription.active",
    payload: {},
    teamId: "team_1",
    externalSubscriptionId: "ext_sub_1",
    metadata: {},
    snapshot: {
      teamId: "team_1",
      provider: "creem",
      planFamily: "team_standard",
      status: "active",
      billingInterval: "unknown",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      externalCustomerId: "cus_1",
      externalSubscriptionId: "ext_sub_1",
      externalSubscriptionItemId: null,
      externalProductId: "prod_1",
      billingOrderId: null,
      cancelAtPeriodEnd: false,
      metadata: {},
      seatCount: 2,
    },
  });

  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "provider_period_invalid");
  assert.equal(store.webhook?.status, "ignored");
  assert.equal(
    store.webhook?.errorCode,
    "INVALID_PROVIDER_SUBSCRIPTION_PERIOD",
  );
  assert.equal(store.subscription, null);
});

test("creem scheduled cancel webhook keeps paid access and marks period-end cancellation", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );
  const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    billing: billingService,
    alerts: { async trigger() {}, async resolve() {} } as any,
  });
  const currentStart = new Date().toISOString();
  const currentEnd = new Date(Date.now() + 31 * 86_400_000).toISOString();

  await syncCreemSubscriptionEvent(
    "subscription.scheduled_cancel",
    {
      webhookId: "evt_scheduled_cancel",
      id: "ext_sub_1",
      status: "scheduled_cancel",
      current_period_start_date: currentStart,
      current_period_end_date: currentEnd,
      customer: { id: "cus_1" },
      product: { id: "prod_team_monthly" },
      items: [{ id: "item_1", units: 3 }],
      metadata: {
        teamId: "team_1",
        planFamily: "team_standard",
        billingInterval: "monthly",
      },
    },
    "active",
  );

  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.subscription?.status, "active");
  assert.equal(store.subscription?.cancelAtPeriodEnd, true);
  assert.equal(store.account?.planFamily, "team_standard");
  assert.equal(store.account?.cycleSource, "provider_subscription");
  assert.equal(store.account?.seatCount, 3);
});

test("creem subscription update with scheduled_cancel status matches scheduled cancel semantics", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );
  const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    billing: billingService,
    alerts: { async trigger() {}, async resolve() {} } as any,
  });
  const currentStart = new Date().toISOString();
  const currentEnd = new Date(Date.now() + 31 * 86_400_000).toISOString();

  await syncCreemSubscriptionEvent(
    "subscription.update",
    {
      webhookId: "evt_update_scheduled_cancel",
      id: "ext_sub_1",
      status: "scheduled_cancel",
      current_period_start_date: currentStart,
      current_period_end_date: currentEnd,
      customer: { id: "cus_1" },
      product: { id: "prod_team_monthly" },
      items: [{ id: "item_1", units: 2 }],
      metadata: {
        teamId: "team_1",
        planFamily: "team_standard",
        billingInterval: "monthly",
      },
    },
    "active",
  );

  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.subscription?.status, "active");
  assert.equal(store.subscription?.cancelAtPeriodEnd, true);
  assert.equal(store.account?.planFamily, "team_standard");
  assert.equal(store.account?.cycleSource, "provider_subscription");
});

test("creem canceled webhook downgrades account to free cycle", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );
  const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    billing: billingService,
    alerts: { async trigger() {}, async resolve() {} } as any,
  });
  const currentStart = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const currentEnd = new Date(Date.now() - 1_000).toISOString();

  await syncCreemSubscriptionEvent(
    "subscription.canceled",
    {
      webhookId: "evt_canceled",
      id: "ext_sub_1",
      status: "active",
      current_period_start_date: currentStart,
      current_period_end_date: currentEnd,
      customer: { id: "cus_1" },
      product: { id: "prod_team_monthly" },
      items: [{ id: "item_1", units: 2 }],
      metadata: {
        teamId: "team_1",
        planFamily: "team_standard",
        billingInterval: "monthly",
      },
    },
    "canceled",
  );

  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.subscription?.status, "canceled");
  assert.equal(store.account?.planFamily, "individual_free");
  assert.equal(store.account?.cycleSource, "free_account");
});

test("creem cancellation webhook without team metadata resolves existing subscription by provider id", async () => {
  const store = new MemoryBillingStore();
  const now = new Date().toISOString();
  store.account = {
    teamId: "team_1",
    userId: "user_1",
    planFamily: "team_standard",
    cycleAnchorAt: now,
    cycleSource: "provider_subscription",
    cycleStartAt: now,
    cycleEndAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    pagesLimit: 8_000,
    pagesUsed: 0,
    monthlyPagesGrant: 8_000,
    monthlyPagesBalance: 8_000,
    addOnPagesBalance: 0,
    pagesConsumedThisCycle: 0,
    monthlyCreditsGrant: 20_000,
    monthlyCreditsBalance: 20_000,
    addOnCreditsBalance: 0,
    creditsReserved: 0,
    creditsConsumedThisCycle: 0,
    seatCount: 2,
    spendSoftCapUsd: null,
    spendHardCapUsd: null,
    createdAt: now,
    updatedAt: now,
  };
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: store.account!.cycleEndAt,
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: "item_1",
    externalProductId: "prod_team_monthly",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );
  const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    billing: billingService,
    alerts: { async trigger() {}, async resolve() {} } as any,
  });

  await syncCreemSubscriptionEvent(
    "subscription.scheduled_cancel",
    {
      webhookId: "evt_scheduled_cancel_without_metadata",
      id: "ext_sub_1",
      status: "scheduled_cancel",
      customer: { id: "cus_1" },
      product: { id: "prod_team_monthly" },
    },
    "active",
  );

  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.subscription?.teamId, "team_1");
  assert.equal(store.subscription?.status, "active");
  assert.equal(store.subscription?.cancelAtPeriodEnd, true);
  assert.equal(store.account?.planFamily, "team_standard");
});

test("duplicate creem cancellation webhook is idempotent", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );
  const alerts = { async trigger() {}, async resolve() {} };
  const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    billing: billingService,
    alerts: alerts as any,
  });
  const currentStart = new Date().toISOString();
  const currentEnd = new Date(Date.now() + 31 * 86_400_000).toISOString();
  const payload = {
    webhookId: "evt_duplicate_cancel",
    id: "ext_sub_1",
    status: "scheduled_cancel",
    current_period_start_date: currentStart,
    current_period_end_date: currentEnd,
    customer: { id: "cus_1" },
    product: { id: "prod_team_monthly" },
    items: [{ id: "item_1", units: 2 }],
    metadata: {
      teamId: "team_1",
      planFamily: "team_standard",
      billingInterval: "monthly",
    },
  };

  await syncCreemSubscriptionEvent(
    "subscription.scheduled_cancel",
    payload,
    "active",
  );
  const ledgerCount = store.ledgers.length;
  await syncCreemSubscriptionEvent(
    "subscription.scheduled_cancel",
    payload,
    "active",
  );

  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.webhook?.attemptCount, 2);
  assert.equal(store.ledgers.length, ledgerCount);
  assert.equal(store.subscription?.cancelAtPeriodEnd, true);
});

test("creem expired event status overrides active payload status", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );
  const alerts = {
    async trigger() {},
    async resolve() {},
  };
  const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    billing: billingService,
    alerts: alerts as any,
  });
  const sameInstant = new Date().toISOString();

  await syncCreemSubscriptionEvent(
    "subscription.expired",
    {
      webhookId: "evt_expired",
      id: "ext_sub_1",
      status: "active",
      current_period_start_date: sameInstant,
      current_period_end_date: sameInstant,
      customer: { id: "cus_1" },
      metadata: {
        teamId: "team_1",
        planFamily: "team_standard",
        seatCount: 2,
      },
    },
    "expired",
  );

  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.subscription?.status, "expired");
  assert.equal(store.subscription?.billingInterval, "unknown");
});

test("creem webhook resolves team seats from subscription item units", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );
  const alerts = {
    async trigger() {},
    async resolve() {},
  };
  const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    billing: billingService,
    alerts: alerts as any,
  });
  const currentStart = new Date().toISOString();
  const currentEnd = new Date(Date.now() + 31 * 86_400_000).toISOString();

  await syncCreemSubscriptionEvent(
    "subscription.active",
    {
      webhookId: "evt_items_units",
      id: "ext_sub_1",
      status: "active",
      current_period_start_date: currentStart,
      current_period_end_date: currentEnd,
      customer: { id: "cus_1" },
      product: { id: "prod_team_monthly" },
      items: [
        {
          id: "item_1",
          units: 4,
        },
      ],
      metadata: {
        teamId: "team_1",
        planFamily: "team_standard",
        billingInterval: "monthly",
      },
    },
    "active",
  );

  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.subscription?.planFamily, "team_standard");
  assert.equal(store.subscription?.billingInterval, "monthly");
  assert.equal(store.account?.seatCount, 4);
});

test("creem active webhook after scheduled cancel clears personal pro period-end cancellation", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      teamBillingEnabled: false,
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/pro",
          externalCheckoutId: "checkout_1",
          externalCustomerId: "cus_1",
        };
      },
    },
  );
  const syncCreemSubscriptionEvent = createCreemSubscriptionSync({
    config: runtimeConfig,
    logger: { info() {}, warn() {}, error() {} },
    billing: billingService,
    alerts: { async trigger() {}, async resolve() {} } as any,
  });
  const checkout = await billingService.createPricingCheckout(
    {
      plan: "pro",
      billingInterval: "monthly",
      source: "landing",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
    { personalTeamId: "personal_1" },
  );
  const currentStart = new Date().toISOString();
  const currentEnd = new Date(Date.now() + 31 * 86_400_000).toISOString();
  const basePayload = {
    id: "sub_pro_1",
    current_period_start_date: currentStart,
    current_period_end_date: currentEnd,
    customer: { id: "cus_1" },
    product: { id: "prod_individual_monthly" },
    items: [{ id: "item_1", units: 1 }],
    metadata: {
      teamId: "personal_1",
      orderId: checkout.orderId,
      planFamily: "individual_pro",
      billingInterval: "monthly",
    },
  };

  await syncCreemSubscriptionEvent(
    "subscription.active",
    {
      ...basePayload,
      webhookId: "evt_initial_active",
      status: "active",
    },
    "active",
  );
  await syncCreemSubscriptionEvent(
    "subscription.scheduled_cancel",
    {
      ...basePayload,
      webhookId: "evt_scheduled_cancel",
      status: "scheduled_cancel",
    },
    "active",
  );
  await syncCreemSubscriptionEvent(
    "subscription.active",
    {
      ...basePayload,
      webhookId: "evt_resumed_active",
      status: "active",
    },
    "active",
  );

  assert.equal(store.webhooks.size, 3);
  assert.equal(store.order?.status, "fulfilled");
  assert.equal(store.subscription?.status, "active");
  assert.equal(store.subscription?.cancelAtPeriodEnd, false);
  assert.equal(store.account?.teamId, "personal_1");
  assert.equal(store.account?.planFamily, "individual_pro");
  assert.equal(store.account?.cycleSource, "provider_subscription");
});
