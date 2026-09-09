import assert from "node:assert/strict";
import { test } from "vitest";
import { BillingAccountService } from "../src/server/account-service";
import { BillingService } from "../src/server/service";
import { BillingUsageService } from "../src/server/usage-service";
import {
  runtimeConfig,
  MemoryBillingStore,
  noopProvider,
  assertRejectsWithBillingCode,
} from "./test-fixtures";

test("default free quota can be configured by runtime env", async () => {
  const store = new MemoryBillingStore();
  const configuredQuota = {
    ...runtimeConfig,
    defaultMonthlyPages: 42,
    defaultMonthlyCredits: 1234,
  };
  const accountService = new BillingAccountService(store, configuredQuota);
  const usageService = new BillingUsageService(
    store,
    configuredQuota,
    accountService,
  );

  const summary = await usageService.getSummary("team_1", "user_1");

  assert.equal(summary.pages.monthlyGrant, 42);
  assert.equal(summary.pages.available, 42);
  assert.equal(summary.credits.monthlyGrant, 1234);
  assert.equal(summary.credits.available, 1234);
});

test("free billing cycle anchors to account creation time", async () => {
  const store = new MemoryBillingStore();
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  const summary = await usageService.getSummary("team_1", "user_1");

  assert.equal(summary.cycleSource, "free_account");
  assert.equal(summary.cycleAnchorAt, summary.cycleStartAt);
});

test("expired paid monthly cycle waits for provider renewal webhook", async () => {
  const store = new MemoryBillingStore();
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  await usageService.meterIngestion(
    "team_1",
    {
      pages: 12,
      feature: "ingestion",
      idempotencyKey: "source-index:4",
    },
    "user_1",
  );

  assert.ok(store.account);
  const expiredStart = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const expiredEnd = new Date(Date.now() - 60_000).toISOString();
  store.account = {
    ...store.account,
    planFamily: "team_standard",
    cycleAnchorAt: expiredStart,
    cycleSource: "provider_subscription",
    cycleStartAt: expiredStart,
    cycleEndAt: expiredEnd,
    monthlyCreditsGrant: 40_000,
    monthlyCreditsBalance: 40_000,
    monthlyPagesGrant: 12_000,
    monthlyPagesBalance: 12_000,
    pagesConsumedThisCycle: 12,
    pagesUsed: 12,
    pagesLimit: 12_000,
    seatCount: 2,
  };
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: expiredStart,
    currentPeriodEnd: expiredEnd,
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_1",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: expiredStart,
    createdAt: expiredStart,
    updatedAt: expiredStart,
  };

  const summary = await usageService.getSummary("team_1", "user_1");

  assert.equal(summary.cycleStartAt, expiredStart);
  assert.equal(summary.cycleEndAt, expiredEnd);
  assert.equal(summary.credits.monthlyBalance, 0);
  assert.equal(summary.pages.monthlyBalance, 0);
  assert.equal(summary.pages.addOnBalance, 0);

  const cycleGrantsAfterExpiry = store.ledgers.filter(
    (entry) =>
      entry.eventType === "grant" &&
      entry.feature === "cycle_grant" &&
      entry.metadata.source === "cycle_sync",
  );
  assert.equal(cycleGrantsAfterExpiry.length, 0);
});

test("stale provider monthly snapshot is rejected before subscription upsert", async () => {
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

  await billingService.ensureBillingAccount("team_1", "user_1");
  assert.ok(store.account);

  const currentStart = new Date(Date.now() - 62 * 86_400_000).toISOString();
  const currentEnd = new Date(Date.now() - 31 * 86_400_000).toISOString();
  store.account = {
    ...store.account,
    planFamily: "team_standard",
    cycleAnchorAt: currentStart,
    cycleSource: "provider_subscription",
    cycleStartAt: currentStart,
    cycleEndAt: currentEnd,
    monthlyCreditsGrant: 40_000,
    monthlyCreditsBalance: 0,
    monthlyPagesGrant: 12_000,
    monthlyPagesBalance: 0,
    pagesLimit: 12_000,
    seatCount: 2,
  };
  const initialAccount = { ...store.account };

  const staleStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const staleEnd = new Date(Date.now() - 60_000).toISOString();
  await assertRejectsWithBillingCode(
    () =>
      billingService.syncSubscriptionSnapshot({
        teamId: "team_1",
        provider: "creem",
        planFamily: "team_standard",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: staleStart,
        currentPeriodEnd: staleEnd,
        externalCustomerId: "cus_1",
        externalSubscriptionId: "ext_sub_1",
        externalSubscriptionItemId: null,
        externalProductId: "prod_1",
        billingOrderId: null,
        cancelAtPeriodEnd: false,
        metadata: {},
        seatCount: 2,
      }),
    "INVALID_PROVIDER_SUBSCRIPTION_PERIOD",
  );

  assert.equal(store.subscription, null);
  assert.equal(store.account?.cycleStartAt, initialAccount.cycleStartAt);
  assert.equal(store.account?.monthlyCreditsBalance, 0);
  assert.equal(store.account?.monthlyPagesBalance, 0);

  const cycleGrants = store.ledgers.filter(
    (entry) =>
      entry.eventType === "grant" &&
      entry.feature === "cycle_grant" &&
      entry.metadata.reason === "provider_period_confirmed",
  );
  assert.equal(cycleGrants.length, 0);
});

test("active provider snapshot without usable period is rejected before subscription upsert", async () => {
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

  await billingService.ensureBillingAccount("team_1", "user_1");
  assert.ok(store.account);
  const initialAccount = { ...store.account };

  await assertRejectsWithBillingCode(
    () =>
      billingService.syncSubscriptionSnapshot({
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
      }),
    "INVALID_PROVIDER_SUBSCRIPTION_PERIOD",
  );

  assert.equal(store.subscription, null);
  assert.equal(store.account?.planFamily, initialAccount.planFamily);
  assert.equal(store.account?.cycleSource, initialAccount.cycleSource);
  assert.equal(store.account?.cycleStartAt, initialAccount.cycleStartAt);
});
