import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { BillingStore } from "./store-port";
import { BillingAccountService } from "./account-service";
import { validateBillingCatalog } from "./catalog";
import { createCreemSubscriptionSync } from "./providers/creem-subscription-sync";
import { BillingService } from "./service";
import { BillingUsageService } from "./usage-service";
import type {
  BillingAccountState,
  BillingLedgerRow,
  BillingOrderState,
  BillingRuntimeConfig,
  BillingSubscriptionState,
  BillingWebhookEventState,
  BillingWebhookStatus,
  BillingProviderAdapter,
  TeamSubscriptionSnapshot,
} from "./types";

const client = {} as PoolClient;

const runtimeConfig: BillingRuntimeConfig = {
  mode: "enforced",
  scope: "individual_only",
  provider: "none",
  creditsEnabled: true,
  pagesEnabled: true,
  enforceLimits: true,
  teamBillingEnabled: false,
  creditUnitUsd: 0.00125,
  defaultMarkupRate: 0.25,
  defaultPlanFamily: "individual_free",
  reconcileEnabled: false,
  creem: {
    apiKey: "",
    webhookSecret: "",
    testMode: true,
    individualProMonthlyProductId: "prod_individual_monthly",
    individualProYearlyProductId: "prod_individual_yearly",
    teamStandardMonthlyProductId: "prod_team_monthly",
    teamStandardYearlyProductId: "prod_team_yearly",
    creditTopupProductId: "prod_credit_topup",
    pageTopupProductId: "prod_page_topup",
  },
  catalog: {
    individualProMonthlyAmountCents: 1200,
    individualProYearlyAmountCents: 9600,
    teamStandardMonthlyAmountCents: 4900,
    teamStandardYearlyAmountCents: 39200,
    creditTopupUnitAmount: 10000,
    creditTopupAmountCents: 1250,
    pageTopupUnitAmount: 1000,
    pageTopupAmountCents: 500,
  },
  defaultSuccessUrl: "http://localhost:3000/app/billing?checkout=success",
};

class MemoryBillingStore implements BillingStore {
  account: BillingAccountState | null = null;
  subscription: BillingSubscriptionState | null = null;
  order: BillingOrderState | null = null;
  webhook: BillingWebhookEventState | null = null;
  ledgers: BillingLedgerRow[] = [];
  teamMemberCount = 1;
  pendingInvitationCount = 0;

  async runInTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
    return fn(client);
  }

  async getAccount() {
    return this.account;
  }

  async getAccountForUpdate() {
    return this.account;
  }

  async insertAccount(account: BillingAccountState) {
    this.account = { ...account };
  }

  async updateAccount(account: BillingAccountState) {
    this.account = { ...account };
  }

  async appendLedger(entry: BillingLedgerRow) {
    this.ledgers.push({ ...entry, metadata: { ...entry.metadata } });
  }

  async getLedgerByIdempotency(teamId: string, idempotencyKey: string) {
    return (
      this.ledgers.find(
        (entry) =>
          entry.teamId === teamId && entry.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async listLedger() {
    return [...this.ledgers];
  }

  async countTeamMembers() {
    return this.teamMemberCount;
  }

  async countPendingTeamInvitations() {
    return this.pendingInvitationCount;
  }

  async getSubscriptionByTeam() {
    return this.subscription;
  }

  async upsertSubscription(
    snapshot: TeamSubscriptionSnapshot,
  ): Promise<BillingSubscriptionState> {
    const now = new Date().toISOString();
    const nextSubscription: BillingSubscriptionState = {
      id: this.subscription?.id ?? "sub_1",
      teamId: snapshot.teamId,
      provider: snapshot.provider,
      planFamily: snapshot.planFamily,
      status: snapshot.status,
      billingInterval: snapshot.billingInterval,
      currentPeriodStart: snapshot.currentPeriodStart,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      externalCustomerId: snapshot.externalCustomerId,
      externalSubscriptionId: snapshot.externalSubscriptionId,
    externalSubscriptionItemId: snapshot.externalSubscriptionItemId ?? null,
      externalProductId: snapshot.externalProductId,
    billingOrderId: snapshot.billingOrderId ?? null,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      metadata: snapshot.metadata,
      lastEventAt: now,
      createdAt: this.subscription?.createdAt ?? now,
      updatedAt: now,
    };
    this.subscription = nextSubscription;
    return nextSubscription;
  }

  async getOrderById() {
    return this.order;
  }

  async getOrderByIdForUpdate() {
    return this.order;
  }

  async getOrderByClientReference() {
    return this.order;
  }

  async getOrderByProviderCheckoutId() {
    return this.order;
  }

  async insertOrder(order: BillingOrderState) {
    this.order = { ...order, metadata: { ...order.metadata } };
    return this.order;
  }

  async updateOrder(order: BillingOrderState) {
    this.order = { ...order, metadata: { ...order.metadata } };
    return this.order;
  }

  async findOpenSubscriptionOrder() {
    return this.order;
  }

  async listRetryableOrders() {
    return this.order &&
      (this.order.status === "payment_confirmed" ||
        this.order.status === "fulfillment_failed")
      ? [this.order]
      : [];
  }

  async getWebhookEventByProviderEventId() {
    return this.webhook;
  }

  async insertWebhookEvent(): Promise<BillingWebhookEventState> {
    const now = new Date().toISOString();
    this.webhook = {
      id: "webhook_1",
      provider: "creem",
      providerEventId: "evt_1",
      eventType: "subscription.active",
      teamId: null,
      externalSubscriptionId: null,
      status: "received",
      attemptCount: 1,
      receivedAt: now,
      processedAt: null,
      errorCode: null,
      errorMessage: null,
      payload: {},
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    return this.webhook;
  }

  async incrementWebhookEventAttempt(): Promise<BillingWebhookEventState> {
    throw new Error("not implemented");
  }

  async updateWebhookEventState(
    _webhookEventId: string,
    _input: { status: BillingWebhookStatus },
  ): Promise<BillingWebhookEventState> {
    if (!this.webhook) {
      throw new Error("webhook not found");
    }

    this.webhook = {
      ...this.webhook,
      ..._input,
      updatedAt: new Date().toISOString(),
    };
    return this.webhook;
  }

  async listAccountSubscriptionStates() {
    return [];
  }
}

const noopProvider: BillingProviderAdapter = {
  async createCheckout() {
    throw new Error("not implemented");
  },
  async createPortal() {
    throw new Error("not implemented");
  },
  async updateSubscriptionSeats() {
    throw new Error("not implemented");
  },
};

async function assertRejectsWithBillingCode(
  action: () => Promise<unknown>,
  code: string,
) {
  await assert.rejects(action, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

test("page quota writes grant and consume ledger balances", async () => {
  const store = new MemoryBillingStore();
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  const result = await usageService.meterIngestion(
    "team_1",
    {
      pages: 6,
      feature: "ingestion",
      referenceId: "source:1",
      idempotencyKey: "source-index:1",
    },
    "user_1",
  );

  assert.equal(result.pagesConsumed, 6);
  assert.equal(result.pagesUsed, 6);
  assert.equal(result.pagesRemaining, 294);

  const pageLedgers = store.ledgers.filter((entry) => entry.unitType === "page");
  assert.equal(pageLedgers.length, 2);

  assert.equal(pageLedgers[0]?.eventType, "grant");
  assert.equal(pageLedgers[0]?.delta, 300);
  assert.equal(pageLedgers[0]?.balanceAfter, 300);
  assert.equal(pageLedgers[0]?.feature, "cycle_grant");

  assert.equal(pageLedgers[1]?.eventType, "consume");
  assert.equal(pageLedgers[1]?.delta, -6);
  assert.equal(pageLedgers[1]?.balanceAfter, 294);
  assert.deepEqual(pageLedgers[1]?.metadata, {
    monthlyPagesGrant: 300,
    monthlyPagesBalance: 294,
    addOnPagesBalance: 0,
    consumedThisCycle: 6,
  });
});

test("shadow page overage grants add-on pages before consuming", async () => {
  const store = new MemoryBillingStore();
  const shadowConfig: BillingRuntimeConfig = {
    ...runtimeConfig,
    mode: "shadow",
  };
  const accountService = new BillingAccountService(store, shadowConfig);
  const usageService = new BillingUsageService(
    store,
    shadowConfig,
    accountService,
  );

  await usageService.meterIngestion(
    "team_1",
    {
      pages: 305,
      feature: "ingestion",
      idempotencyKey: "source-index:2",
    },
    "user_1",
  );

  const pageLedgers = store.ledgers.filter((entry) => entry.unitType === "page");
  assert.equal(pageLedgers.length, 3);

  assert.equal(pageLedgers[0]?.eventType, "grant");
  assert.equal(pageLedgers[0]?.delta, 300);
  assert.equal(pageLedgers[0]?.balanceAfter, 300);

  assert.equal(pageLedgers[1]?.eventType, "grant");
  assert.equal(pageLedgers[1]?.feature, "shadow_auto_grant");
  assert.equal(pageLedgers[1]?.delta, 5);
  assert.equal(pageLedgers[1]?.balanceAfter, 305);

  assert.equal(pageLedgers[2]?.eventType, "consume");
  assert.equal(pageLedgers[2]?.delta, -305);
  assert.equal(pageLedgers[2]?.balanceAfter, 0);
});

test("monthly pages expire and regrant while add-on pages carry over", async () => {
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
      pages: 290,
      feature: "ingestion",
      idempotencyKey: "source-index:3",
    },
    "user_1",
  );

  assert.ok(store.account);
  store.account = {
    ...store.account,
    cycleEndAt: new Date(Date.now() - 60_000).toISOString(),
    addOnPagesBalance: 7,
  };

  const summary = await usageService.getSummary("team_1");

  assert.equal(summary.pages.monthlyGrant, 300);
  assert.equal(summary.pages.monthlyBalance, 300);
  assert.equal(summary.pages.addOnBalance, 7);
  assert.equal(summary.pages.consumedThisCycle, 0);
  assert.equal(summary.pages.used, 0);
  assert.equal(summary.pages.remaining, 307);

  const pageLedgers = store.ledgers.filter((entry) => entry.unitType === "page");
  const expireLedger = pageLedgers.find(
    (entry) => entry.eventType === "expire",
  );
  const cycleGrants = pageLedgers.filter(
    (entry) =>
      entry.eventType === "grant" && entry.feature === "cycle_grant",
  );

  assert.equal(expireLedger?.delta, -10);
  assert.equal(expireLedger?.balanceAfter, 7);
  assert.equal(cycleGrants.at(-1)?.delta, 300);
  assert.equal(cycleGrants.at(-1)?.balanceAfter, 307);
});

test("free billing cycle anchors to account creation time", async () => {
  const store = new MemoryBillingStore();
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  const summary = await usageService.getSummary("team_1");

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

  const summary = await usageService.getSummary("team_1");

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
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );

  await billingService.ensureBillingAccount("team_1");
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
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );

  await billingService.ensureBillingAccount("team_1");
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

test("webhook with active snapshot without usable period is ignored without retry failure", async () => {
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
  assert.equal(store.webhook?.errorCode, "INVALID_PROVIDER_SUBSCRIPTION_PERIOD");
  assert.equal(store.subscription, null);
});

test("team subscription checkout rejects seats below current members", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 3;
  const providerCalls: Array<unknown> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push(input);
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/team",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  await assertRejectsWithBillingCode(
    () =>
      billingService.createSubscriptionCheckout(
        "team_1",
        {
          planFamily: "team_standard",
          billingInterval: "monthly",
          seatCount: 2,
        },
        {
          userId: "user_1",
          email: "user@example.com",
        },
      ),
    "SEAT_COUNT_BELOW_MEMBERS",
  );
  assert.equal(providerCalls.length, 0);
});

test("team subscription seat sync updates provider before local quota", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 3;
  const now = new Date().toISOString();
  store.account = {
    teamId: "team_1",
    planFamily: "team_standard",
    cycleAnchorAt: now,
    cycleSource: "provider_subscription",
    cycleStartAt: now,
    cycleEndAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    pagesLimit: 12_000,
    pagesUsed: 0,
    monthlyPagesGrant: 12_000,
    monthlyPagesBalance: 12_000,
    addOnPagesBalance: 0,
    pagesConsumedThisCycle: 0,
    monthlyCreditsGrant: 40_000,
    monthlyCreditsBalance: 40_000,
    addOnCreditsBalance: 0,
    creditsReserved: 0,
    creditsConsumedThisCycle: 0,
    seatCount: 3,
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
    currentPeriodEnd: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_team_monthly",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const updates: Array<{ externalSubscriptionId: string; seatCount: number }> =
    [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        updates.push({
          externalSubscriptionId: input.externalSubscriptionId,
          seatCount: input.seatCount,
        });
        return {
          provider: "creem",
          seatCount: input.seatCount,
        };
      },
    },
  );

  const result = await billingService.syncTeamSubscriptionSeats("team_1", {
    seatCount: 5,
    actorUserId: "user_1",
  });

  assert.deepEqual(updates, [
    {
      externalSubscriptionId: "ext_sub_1",
      seatCount: 5,
    },
  ]);
  assert.equal(result.seatCount, 5);
  assert.equal(result.seatsUsed, 3);
  assert.equal(store.account?.seatCount, 5);
  assert.equal(store.account?.monthlyCreditsGrant, 100_000);
  assert.equal(store.account?.monthlyPagesGrant, 30_000);
});

test("team subscription seat sync failure leaves local seat count unchanged", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const now = new Date().toISOString();
  await new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  ).ensureBillingAccount("team_1");
  assert.ok(store.account);
  store.account = {
    ...store.account,
    planFamily: "team_standard",
    seatCount: 2,
    monthlyCreditsGrant: 40_000,
    monthlyPagesGrant: 12_000,
  };
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_team_monthly",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const alerts: Array<Record<string, unknown>> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats() {
        throw new Error("provider down");
      },
    },
    {
      async trigger(input) {
        alerts.push(input);
      },
      async resolve() {},
    },
  );

  await assert.rejects(
    () => billingService.syncTeamSubscriptionSeats("team_1", { seatCount: 4 }),
    /provider down/,
  );
  assert.equal(store.account?.seatCount, 2);
  assert.equal(store.account?.monthlyCreditsGrant, 40_000);
  assert.equal(store.account?.monthlyPagesGrant, 12_000);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.alertKey, "billing:seat-sync:failed:team_1");
});

test("active team subscription rejects invitations at seat capacity", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  const now = new Date().toISOString();
  await new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  ).ensureBillingAccount("team_1");
  assert.ok(store.account);
  store.account = {
    ...store.account,
    planFamily: "team_standard",
    seatCount: 3,
  };
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
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
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );

  await assertRejectsWithBillingCode(
    () => billingService.assertCanInviteTeamMember("team_1"),
    "TEAM_SEAT_LIMIT_REACHED",
  );
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

test("billing portal actions reject subscriptions without provider customer", async () => {
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

  await billingService.ensureBillingAccount("team_1");
  const now = new Date().toISOString();
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    externalCustomerId: null,
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_1",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await assertRejectsWithBillingCode(
    () => billingService.createBillingPortal("team_1", "user_1"),
    "BILLING_CUSTOMER_NOT_FOUND",
  );
  await assertRejectsWithBillingCode(
    () => billingService.cancelSubscription("team_1", "user_1"),
    "BILLING_CUSTOMER_NOT_FOUND",
  );
});

test("pricing pro checkout reuses open order for same personal organization", async () => {
  const store = new MemoryBillingStore();
  const providerCalls: Array<unknown> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push(input);
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/pro",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  const first = await billingService.createPricingCheckout(
    {
      plan: "pro",
      billingInterval: "monthly",
      source: "dashboard",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
    { personalTeamId: "personal_1" },
  );
  const second = await billingService.createPricingCheckout(
    {
      plan: "pro",
      billingInterval: "monthly",
      source: "dashboard",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
    { personalTeamId: "personal_1" },
  );

  assert.equal(first.orderId, second.orderId);
  assert.equal(providerCalls.length, 1);
  assert.equal(store.order?.teamId, "personal_1");
});

test("team pricing checkout leaves team empty until fulfillment", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/team",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  const checkout = await billingService.createPricingCheckout(
    {
      plan: "team",
      billingInterval: "yearly",
      source: "landing",
      teamName: "Launch Lab",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
  );

  assert.equal(checkout.planFamily, "team_standard");
  assert.equal(checkout.quantity, 2);
  assert.equal(store.order?.teamId, null);
  assert.equal(store.order?.status, "checkout_created");
  assert.equal(store.order?.metadata.teamName, "Launch Lab");
});

test("top-up fulfillment is idempotent and ledger backed", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/topup",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  const checkout = await billingService.createTopupCheckout(
    "team_1",
    {
      unitType: "credit",
      quantity: 2,
    },
    "user_1",
    "user@example.com",
  );

  await billingService.fulfillOrder({ orderId: checkout.orderId });
  await billingService.fulfillOrder({ orderId: checkout.orderId });

  const topupLedgers = store.ledgers.filter(
    (entry) => entry.feature === "credit_topup_purchase",
  );
  assert.equal(topupLedgers.length, 1);
  assert.equal(topupLedgers[0]?.delta, 20_000);
  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.equal(store.order?.status, "fulfilled");
});

test("catalog validation catches missing active provider product", async () => {
  assert.throws(
    () =>
      validateBillingCatalog({
        runtimeConfig: {
          ...runtimeConfig,
          provider: "creem",
          creem: {
            ...runtimeConfig.creem,
            teamStandardYearlyProductId: "",
          },
        },
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "BILLING_CATALOG_INVALID");
      return true;
    },
  );
});
