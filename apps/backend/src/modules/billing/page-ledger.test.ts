import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { BillingStore } from "./store-port";
import { BillingAccountService } from "./account-service";
import { validateBillingCatalog } from "./catalog";
import { resolveCreemSubscriptionSeatUpdateItem } from "./providers/creem-provider";
import { createCreemSubscriptionSync } from "./providers/creem-subscription-sync";
import { NoopBillingProvider } from "./providers/noop-provider";
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
  saasEnabled: false,
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
  defaultMonthlyPages: 300,
  defaultMonthlyCredits: 3000,
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
  defaultSuccessUrl: "http://localhost:3000/dashboard/billing?checkout=success",
};

class MemoryBillingStore implements BillingStore {
  account: BillingAccountState | null = null;
  subscription: BillingSubscriptionState | null = null;
  order: BillingOrderState | null = null;
  webhook: BillingWebhookEventState | null = null;
  webhooks = new Map<string, BillingWebhookEventState>();
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

  async listLedger(
    teamId: string,
    limit?: number,
    options?: { activityOnly?: boolean },
  ) {
    const entries = this.ledgers.filter(
      (entry) =>
        entry.teamId === teamId &&
        (!options?.activityOnly || entry.activityVisible),
    );
    const sorted = [...entries].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );

    return limit === undefined ? sorted : sorted.slice(0, limit);
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

  async getSubscriptionByProviderSubscription(
    provider: BillingSubscriptionState["provider"],
    externalSubscriptionId: string,
  ) {
    if (
      this.subscription?.provider === provider &&
      this.subscription.externalSubscriptionId === externalSubscriptionId
    ) {
      return this.subscription;
    }

    return null;
  }

  async getLatestCustomerSubscriptionByUser() {
    return this.subscription?.externalCustomerId ? this.subscription : null;
  }

  async getLatestCustomerOrderByUser() {
    return this.order?.externalCustomerId ? this.order : null;
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

  async getWebhookEventByProviderEventId(
    _provider: BillingWebhookEventState["provider"],
    providerEventId: string,
  ) {
    return this.webhooks.get(`${_provider}:${providerEventId}`) ?? null;
  }

  async insertWebhookEvent(input: {
    provider: BillingWebhookEventState["provider"];
    providerEventId: string;
    eventType: string;
    teamId: string | null;
    externalSubscriptionId: string | null;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<BillingWebhookEventState> {
    const now = new Date().toISOString();
    this.webhook = {
      id: "webhook_1",
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      teamId: input.teamId,
      externalSubscriptionId: input.externalSubscriptionId,
      status: "received",
      attemptCount: 1,
      receivedAt: now,
      processedAt: null,
      errorCode: null,
      errorMessage: null,
      payload: input.payload,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    this.webhooks.set(
      `${input.provider}:${input.providerEventId}`,
      this.webhook,
    );
    return this.webhook;
  }

  async incrementWebhookEventAttempt(
    _webhookEventId: string,
    input: {
      eventType: string;
      teamId: string | null;
      externalSubscriptionId: string | null;
      payload: Record<string, unknown>;
      metadata: Record<string, unknown>;
    },
  ): Promise<BillingWebhookEventState> {
    if (!this.webhook) {
      throw new Error("webhook not found");
    }

    this.webhook = {
      ...this.webhook,
      eventType: input.eventType,
      teamId: input.teamId ?? this.webhook.teamId,
      externalSubscriptionId:
        input.externalSubscriptionId ?? this.webhook.externalSubscriptionId,
      payload: input.payload,
      metadata: input.metadata,
      attemptCount: this.webhook.attemptCount + 1,
      updatedAt: new Date().toISOString(),
    };
    if (this.webhook.providerEventId) {
      this.webhooks.set(
        `${this.webhook.provider}:${this.webhook.providerEventId}`,
        this.webhook,
      );
    }
    return this.webhook;
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
    if (this.webhook.providerEventId) {
      this.webhooks.set(
        `${this.webhook.provider}:${this.webhook.providerEventId}`,
        this.webhook,
      );
    }
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

function createActiveTeamAccount(
  overrides: Partial<BillingAccountState> = {},
): BillingAccountState {
  const now = new Date().toISOString();

  return {
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
    seatCount: 2,
    spendSoftCapUsd: null,
    spendHardCapUsd: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createActiveTeamSubscription(
  overrides: Partial<BillingSubscriptionState> = {},
): BillingSubscriptionState {
  const now = new Date().toISOString();

  return {
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
    ...overrides,
  };
}

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

  const pageLedgers = store.ledgers.filter(
    (entry) => entry.unitType === "page",
  );
  assert.equal(pageLedgers.length, 2);

  assert.equal(pageLedgers[0]?.eventType, "grant");
  assert.equal(pageLedgers[0]?.delta, 300);
  assert.equal(pageLedgers[0]?.balanceAfter, 300);
  assert.equal(pageLedgers[0]?.feature, "cycle_grant");

  assert.equal(pageLedgers[1]?.eventType, "consume");
  assert.equal(pageLedgers[1]?.delta, -6);
  assert.equal(pageLedgers[1]?.balanceAfter, 294);
  assert.equal(pageLedgers[1]?.activityVisible, true);
  assert.equal(pageLedgers[1]?.activityTitle, "Pages indexed");
  assert.equal(pageLedgers[1]?.activitySummary, "-6 pages");
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

  const pageLedgers = store.ledgers.filter(
    (entry) => entry.unitType === "page",
  );
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

  const summary = await usageService.getSummary("team_1");

  assert.equal(summary.pages.monthlyGrant, 42);
  assert.equal(summary.pages.available, 42);
  assert.equal(summary.credits.monthlyGrant, 1234);
  assert.equal(summary.credits.available, 1234);
});

test("billing summary counts pending invitations as occupied seats", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({ seatCount: 3 });
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  const summary = await usageService.getSummary("team_1");

  assert.equal(summary.seats.used, 3);
  assert.equal(summary.seats.remaining, 0);
  assert.equal(summary.seats.activeMembers, 2);
  assert.equal(summary.seats.pendingInvitations, 1);

  store.pendingInvitationCount = 0;
  const afterRevoke = await usageService.getSummary("team_1");

  assert.equal(afterRevoke.seats.used, 2);
  assert.equal(afterRevoke.seats.remaining, 1);
  assert.equal(afterRevoke.seats.activeMembers, 2);
  assert.equal(afterRevoke.seats.pendingInvitations, 0);
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

  const pageLedgers = store.ledgers.filter(
    (entry) => entry.unitType === "page",
  );
  const expireLedger = pageLedgers.find(
    (entry) => entry.eventType === "expire",
  );
  const cycleGrants = pageLedgers.filter(
    (entry) => entry.eventType === "grant" && entry.feature === "cycle_grant",
  );

  assert.equal(expireLedger?.delta, -10);
  assert.equal(expireLedger?.balanceAfter, 7);
  assert.equal(cycleGrants.at(-1)?.delta, 300);
  assert.equal(cycleGrants.at(-1)?.balanceAfter, 307);

  const visibleActivity = store.ledgers.filter(
    (entry) => entry.activityVisible,
  );
  const visibleRenewals = visibleActivity.filter(
    (entry) => entry.operationType === "cycle_renewal",
  );
  assert.equal(visibleRenewals.length, 1);
  assert.equal(visibleRenewals[0]?.activityTitle, "Monthly quota renewed");
  assert.equal(
    visibleRenewals[0]?.activitySummary,
    "+3,000 credits, +300 pages",
  );
  assert.equal(visibleRenewals[0]?.feature, "cycle_grant");
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
      saasEnabled: true,
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
      saasEnabled: true,
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

test("team subscription checkout rejects seats below allocated members and invites", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  const providerCalls: Array<unknown> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
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
    "SEAT_COUNT_BELOW_ALLOCATED_SEATS",
  );
  assert.equal(providerCalls.length, 0);
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
    currentPeriodEnd: store.account.cycleEndAt,
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
  const updates: Array<{
    externalSubscriptionId: string;
    externalProductId?: string | null;
    seatCount: number;
    updateBehavior: string;
  }> = [];
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
          externalProductId: input.externalProductId,
          seatCount: input.seatCount,
          updateBehavior: input.updateBehavior,
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
      externalProductId: "prod_team_monthly",
      seatCount: 5,
      updateBehavior: "proration-charge-immediately",
    },
  ]);
  assert.equal(result.seatCount, 5);
  assert.equal(result.seatsUsed, 3);
  assert.equal(store.account?.seatCount, 5);
  assert.equal(store.account?.monthlyCreditsGrant, 100_000);
  assert.equal(store.account?.monthlyPagesGrant, 30_000);

  const seatLedgers = store.ledgers.filter(
    (entry) => entry.unitType === "seat",
  );
  assert.equal(seatLedgers.length, 1);
  assert.equal(seatLedgers[0]?.eventType, "adjust");
  assert.equal(seatLedgers[0]?.feature, "seat_quota_change");
  assert.equal(seatLedgers[0]?.delta, 2);
  assert.equal(seatLedgers[0]?.balanceAfter, 5);
  assert.equal(seatLedgers[0]?.activityVisible, true);
  assert.equal(seatLedgers[0]?.activityTitle, "Seats updated");
  assert.equal(seatLedgers[0]?.activitySummary, "3 -> 5 seats");

  const seatOperationId = seatLedgers[0]?.operationId;
  assert.ok(seatOperationId);
  const quotaLedgers = store.ledgers.filter(
    (entry) => entry.feature === "seat_quota_grant",
  );
  assert.equal(quotaLedgers.length, 2);
  assert.ok(
    quotaLedgers.every((entry) => entry.operationId === seatOperationId),
  );
  assert.ok(quotaLedgers.every((entry) => entry.activityVisible === false));
});

test("team subscription seat changes are visible per update without merging", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const now = new Date().toISOString();
  const periodEnd = new Date(Date.now() + 31 * 86_400_000).toISOString();
  store.account = {
    teamId: "team_1",
    planFamily: "team_standard",
    cycleAnchorAt: now,
    cycleSource: "provider_subscription",
    cycleStartAt: now,
    cycleEndAt: periodEnd,
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
    currentPeriodEnd: periodEnd,
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
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        return {
          provider: "creem",
          seatCount: input.seatCount,
        };
      },
    },
  );

  await billingService.syncTeamSubscriptionSeats("team_1", { seatCount: 3 });
  await billingService.syncTeamSubscriptionSeats("team_1", { seatCount: 4 });
  await billingService.syncTeamSubscriptionSeats("team_1", { seatCount: 2 });

  const seatLedgers = store.ledgers.filter(
    (entry) => entry.unitType === "seat",
  );
  assert.equal(seatLedgers.length, 3);
  assert.deepEqual(
    seatLedgers.map((entry) => entry.activitySummary),
    ["2 -> 3 seats", "3 -> 4 seats", "4 -> 2 seats"],
  );
  assert.deepEqual(
    seatLedgers.map((entry) => entry.delta),
    [1, 1, -2],
  );

  const activity = await billingService.getLedger("team_1", 20, {
    activityOnly: true,
  });
  const seatActivity = activity.items.filter(
    (entry) => entry.unitType === "seat",
  );
  assert.equal(seatActivity.length, 3);
  assert.ok(activity.items.every((entry) => entry.activityVisible));

  const visibleByOperation = new Map<string, number>();
  for (const entry of activity.items) {
    if (!entry.operationId) {
      continue;
    }

    visibleByOperation.set(
      entry.operationId,
      (visibleByOperation.get(entry.operationId) ?? 0) + 1,
    );
  }

  assert.ok([...visibleByOperation.values()].every((count) => count === 1));
  assert.ok(
    store.ledgers
      .filter(
        (entry) =>
          entry.operationType === "seat_change" && entry.unitType !== "seat",
      )
      .every((entry) => entry.activityVisible === false),
  );
});

test("team subscription seat downgrade fully claws back unused monthly quota", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const nowMs = Date.now();
  const periodStart = new Date(nowMs - 15 * 86_400_000).toISOString();
  const periodEnd = new Date(nowMs + 15 * 86_400_000).toISOString();
  store.account = createActiveTeamAccount({
    cycleStartAt: periodStart,
    cycleEndAt: periodEnd,
    seatCount: 3,
    monthlyCreditsGrant: 60_000,
    monthlyCreditsBalance: 60_000,
    monthlyPagesGrant: 18_000,
    monthlyPagesBalance: 18_000,
    pagesLimit: 18_000,
  });
  store.subscription = createActiveTeamSubscription({
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  const updates: Array<{ seatCount: number; updateBehavior: string }> = [];
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
          seatCount: input.seatCount,
          updateBehavior: input.updateBehavior,
        });
        return {
          provider: "creem",
          seatCount: input.seatCount,
        };
      },
    },
  );

  const preview = await billingService.previewTeamSubscriptionSeats("team_1", {
    seatCount: 2,
  });
  assert.equal(preview.quotaAdjustment?.targetCredits, 10_000);
  assert.equal(preview.quotaAdjustment?.actualCredits, 10_000);
  assert.equal(preview.quotaAdjustment?.targetPages, 3_000);
  assert.equal(preview.quotaAdjustment?.actualPages, 3_000);
  assert.equal(preview.quotaAdjustment?.refundRatio, 1);
  assert.equal(preview.billingAdjustment?.providerAction, "proration_credit");

  const result = await billingService.syncTeamSubscriptionSeats("team_1", {
    seatCount: 2,
    actorUserId: "user_1",
  });

  assert.deepEqual(updates, [
    {
      seatCount: 2,
      updateBehavior: "proration-charge",
    },
  ]);
  assert.equal(result.seatCount, 2);
  assert.equal(store.account?.seatCount, 2);
  assert.equal(store.account?.monthlyCreditsGrant, 40_000);
  assert.equal(store.account?.monthlyCreditsBalance, 50_000);
  assert.equal(store.account?.monthlyPagesGrant, 12_000);
  assert.equal(store.account?.monthlyPagesBalance, 15_000);
  assert.equal(
    store.ledgers.some(
      (entry) =>
        entry.feature === "seat_quota_clawback" &&
        entry.unitType === "credit" &&
        entry.delta === -10_000,
    ),
    true,
  );
  assert.equal(
    store.ledgers.some(
      (entry) =>
        entry.feature === "seat_quota_clawback" &&
        entry.unitType === "page" &&
        entry.delta === -3_000,
    ),
    true,
  );
});

test("team subscription seat upgrade preview includes prorated charge", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const nowMs = Date.now();
  const periodStart = new Date(nowMs - 15 * 86_400_000).toISOString();
  const periodEnd = new Date(nowMs + 15 * 86_400_000).toISOString();
  store.account = createActiveTeamAccount({
    cycleStartAt: periodStart,
    cycleEndAt: periodEnd,
    seatCount: 2,
  });
  store.subscription = createActiveTeamSubscription({
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );

  const preview = await billingService.previewTeamSubscriptionSeats("team_1", {
    seatCount: 4,
  });

  assert.equal(preview.quotaAdjustment, null);
  assert.equal(
    preview.billingAdjustment?.providerAction,
    "proration_charge_immediately",
  );
  assert.equal(preview.billingAdjustment?.theoreticalRefundCents, 0);
  assert.equal(preview.billingAdjustment?.actualRefundCents, 0);
  assert.equal(preview.billingAdjustment?.unrefundedCents, 0);
  assert.ok(
    (preview.billingAdjustment?.estimatedChargeCents ?? 0) > 4_800,
  );
  assert.ok(
    (preview.billingAdjustment?.estimatedChargeCents ?? 0) <= 4_900,
  );
});

test("team subscription seat downgrade partially refunds when monthly quota is spent", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const nowMs = Date.now();
  const periodStart = new Date(nowMs - 15 * 86_400_000).toISOString();
  const periodEnd = new Date(nowMs + 15 * 86_400_000).toISOString();
  store.account = createActiveTeamAccount({
    cycleStartAt: periodStart,
    cycleEndAt: periodEnd,
    seatCount: 3,
    monthlyCreditsGrant: 60_000,
    monthlyCreditsBalance: 5_000,
    addOnCreditsBalance: 8_000,
    monthlyPagesGrant: 18_000,
    monthlyPagesBalance: 3_000,
    addOnPagesBalance: 1_000,
    pagesLimit: 18_000,
  });
  store.subscription = createActiveTeamSubscription({
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  const updates: Array<{ seatCount: number; updateBehavior: string }> = [];
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
          seatCount: input.seatCount,
          updateBehavior: input.updateBehavior,
        });
        return {
          provider: "creem",
          seatCount: input.seatCount,
        };
      },
    },
  );

  const preview = await billingService.previewTeamSubscriptionSeats("team_1", {
    seatCount: 2,
  });
  assert.equal(preview.quotaAdjustment?.targetCredits, 10_000);
  assert.equal(preview.quotaAdjustment?.actualCredits, 5_000);
  assert.equal(preview.quotaAdjustment?.targetPages, 3_000);
  assert.equal(preview.quotaAdjustment?.actualPages, 3_000);
  assert.equal(preview.quotaAdjustment?.refundRatio, 0.5);
  assert.equal(
    preview.billingAdjustment?.providerAction,
    "internal_partial_credit",
  );

  const result = await billingService.syncTeamSubscriptionSeats("team_1", {
    seatCount: 2,
    actorUserId: "user_1",
  });

  assert.deepEqual(updates, [
    {
      seatCount: 2,
      updateBehavior: "proration-none",
    },
  ]);
  assert.equal(
    result.billingAdjustment?.providerAction,
    "internal_partial_credit",
  );
  assert.equal(store.account?.monthlyCreditsBalance, 0);
  assert.equal(store.account?.addOnCreditsBalance, 8_000);
  assert.equal(store.account?.monthlyPagesBalance, 0);
  assert.equal(store.account?.addOnPagesBalance, 1_000);
  assert.equal(
    result.billingAdjustment?.actualRefundCents,
    Math.round((result.billingAdjustment?.theoreticalRefundCents ?? 0) * 0.5),
  );
});

test("team subscription seat downgrade is blocked by occupied member and invite seats", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 3;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({
    seatCount: 3,
    monthlyCreditsGrant: 60_000,
    monthlyPagesGrant: 18_000,
    pagesLimit: 18_000,
  });
  store.subscription = createActiveTeamSubscription();
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
    () =>
      billingService.previewTeamSubscriptionSeats("team_1", { seatCount: 2 }),
    "SEAT_COUNT_FILLED_BY_MEMBERS",
  );

  store.teamMemberCount = 2;

  await assertRejectsWithBillingCode(
    () =>
      billingService.previewTeamSubscriptionSeats("team_1", { seatCount: 2 }),
    "SEAT_COUNT_BELOW_ALLOCATED_SEATS",
  );
});

test("creem seat update item includes product or price when updating units", () => {
  assert.deepEqual(
    resolveCreemSubscriptionSeatUpdateItem({
      subscription: {
        product: { id: "prod_team_monthly" },
        items: [{ id: "item_1", units: 3 }],
      },
      seatCount: 5,
    }),
    {
      id: "item_1",
      productId: "prod_team_monthly",
      units: 5,
    },
  );

  assert.deepEqual(
    resolveCreemSubscriptionSeatUpdateItem({
      subscription: {
        product: { id: "prod_team_monthly" },
        items: [{ id: "item_1", price_id: "price_team_monthly", units: 3 }],
      },
      seatCount: 6,
    }),
    {
      id: "item_1",
      productId: "prod_team_monthly",
      priceId: "price_team_monthly",
      units: 6,
    },
  );
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

test("team subscription member sync ignores pending invitations", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({ seatCount: 2 });
  store.subscription = createActiveTeamSubscription();
  const updates: Array<{ seatCount: number; updateBehavior: string }> = [];
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
          seatCount: input.seatCount,
          updateBehavior: input.updateBehavior,
        });
        return { provider: "creem", seatCount: input.seatCount };
      },
    },
  );

  const result = await billingService.syncTeamSubscriptionSeatsToMembers(
    "team_1",
    { reason: "invitation_created" },
  );

  assert.equal(result, null);
  assert.equal(store.account?.seatCount, 2);
  assert.deepEqual(updates, []);

  store.pendingInvitationCount = 0;
  const noDowngrade = await billingService.syncTeamSubscriptionSeatsToMembers(
    "team_1",
    { reason: "invitation_revoked" },
  );

  assert.equal(noDowngrade, null);
  assert.equal(store.account?.seatCount, 2);
  assert.equal(updates.length, 0);
});

test("active team subscription rejects invitations at allocated seat capacity", async () => {
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
  const updates: number[] = [];
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
        updates.push(input.seatCount);
        return { provider: "creem", seatCount: input.seatCount };
      },
    },
  );

  await assertRejectsWithBillingCode(
    () => billingService.assertCanInviteTeamMember("team_1"),
    "TEAM_SEAT_LIMIT_REACHED",
  );

  assert.equal(store.account?.seatCount, 3);
  assert.deepEqual(updates, []);
});

test("active team subscription accepts preallocated invitation without expanding seats", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({ seatCount: 3 });
  store.subscription = createActiveTeamSubscription();
  const updates: number[] = [];
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
        updates.push(input.seatCount);
        return { provider: "creem", seatCount: input.seatCount };
      },
    },
  );

  await billingService.assertCanAcceptTeamInvitation("team_1");

  assert.equal(store.account?.seatCount, 3);
  assert.deepEqual(updates, []);
});

test("active team subscription rejects direct member add when invites occupy remaining seats", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({ seatCount: 3 });
  store.subscription = createActiveTeamSubscription();
  const updates: number[] = [];
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
        updates.push(input.seatCount);
        return { provider: "creem", seatCount: input.seatCount };
      },
    },
  );

  await assertRejectsWithBillingCode(
    () => billingService.assertCanAddTeamMember("team_1"),
    "TEAM_SEAT_LIMIT_REACHED",
  );

  assert.equal(store.account?.seatCount, 3);
  assert.deepEqual(updates, []);
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

test("billing portal actions fall back to the payer customer", async () => {
  const store = new MemoryBillingStore();
  const portalInputs: Array<{
    externalCustomerId?: string | null;
    externalSubscriptionId?: string | null;
  }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createPortal(input) {
        portalInputs.push({
          externalCustomerId: input.externalCustomerId,
          externalSubscriptionId: input.externalSubscriptionId,
        });
        return {
          provider: "creem",
          portalUrl: "https://billing.example.test/portal",
        };
      },
    },
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
  store.order = {
    id: "order_1",
    provider: "creem",
    kind: "subscription",
    status: "fulfilled",
    paymentStatus: "paid",
    userId: "user_1",
    teamId: "personal_1",
    clientReferenceKey: null,
    planFamily: "individual_pro",
    billingInterval: "monthly",
    quantity: 1,
    unitType: null,
    unitAmount: null,
    grantedCredits: 0,
    grantedPages: 0,
    externalCheckoutId: "checkout_1",
    externalPaymentId: "pay_1",
    externalCustomerId: "cus_personal_1",
    externalSubscriptionId: "sub_personal_1",
    externalProductId: "prod_individual_monthly",
    amountTotal: 1200,
    currency: "USD",
    successUrl: null,
    cancelUrl: null,
    metadata: {},
    errorCode: null,
    errorMessage: null,
    paidAt: now,
    fulfilledAt: now,
    expiresAt: null,
    fulfillmentAttemptCount: 1,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const portal = await billingService.createBillingPortal("team_1", "user_1");
  const cancel = await billingService.cancelSubscription("team_1", "user_1");

  assert.equal(portal.portalUrl, "https://billing.example.test/portal");
  assert.equal(cancel.portalUrl, "https://billing.example.test/portal");
  assert.deepEqual(portalInputs, [
    {
      externalCustomerId: "cus_personal_1",
      externalSubscriptionId: "ext_sub_1",
    },
    {
      externalCustomerId: "cus_personal_1",
      externalSubscriptionId: "ext_sub_1",
    },
  ]);
});

test("pricing pro checkout reuses open order for same personal organization", async () => {
  const store = new MemoryBillingStore();
  const providerCalls: Array<unknown> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
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

test("pricing pro order fulfillment works when team billing is disabled", async () => {
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

  const checkout = await billingService.createPricingCheckout(
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

  const result = await billingService.processSubscriptionWebhookEvent({
    provider: "creem",
    providerEventId: "evt_pro_1",
    eventType: "subscription.active",
    payload: {},
    teamId: "personal_1",
    externalSubscriptionId: "sub_pro_1",
    snapshot: null,
    orderFulfillment: {
      orderId: checkout.orderId,
      externalCustomerId: "cus_1",
      externalSubscriptionId: "sub_pro_1",
      externalProductId: "prod_individual_monthly",
      currentPeriodStart: "2026-05-15T00:00:00.000Z",
      currentPeriodEnd: "2026-06-15T00:00:00.000Z",
      status: "active",
    },
  });

  assert.equal(result.outcome, "processed");
  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.order?.status, "fulfilled");
  assert.equal(store.account?.teamId, "personal_1");
  assert.equal(store.account?.planFamily, "individual_pro");
  assert.equal(store.subscription?.planFamily, "individual_pro");
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

test("pricing pro checkout does not reuse failed provider orders", async () => {
  const store = new MemoryBillingStore();
  let shouldFail = true;
  const providerCalls: Array<unknown> = [];
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
      async createCheckout(input) {
        providerCalls.push(input);
        if (shouldFail) {
          shouldFail = false;
          throw new Error("provider unavailable");
        }

        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/pro-retry",
          externalCheckoutId: "checkout_retry",
          externalCustomerId: "cus_retry",
        };
      },
    },
  );

  await assert.rejects(() =>
    billingService.createPricingCheckout(
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
    ),
  );

  assert.equal(store.order?.status, "payment_failed");
  assert.equal(store.order?.paymentStatus, "failed");
  assert.equal(store.order?.errorMessage, "provider unavailable");

  const retry = await billingService.createPricingCheckout(
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

  assert.equal(providerCalls.length, 2);
  assert.equal(retry.checkoutUrl, "https://checkout.example.test/pro-retry");
  assert.equal(store.order?.status, "checkout_created");
});

test("non-creem provider disables checkout before creating orders", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "manual",
      teamBillingEnabled: false,
    },
    new NoopBillingProvider(),
  );

  await assert.rejects(
    () =>
      billingService.createPricingCheckout(
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
      ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "BILLING_CHECKOUT_DISABLED",
      );
      assert.equal(
        (error as Error).message,
        "Billing checkout is disabled for this deployment",
      );
      return true;
    },
  );
  assert.equal(store.order, null);
});

test("oss default disables checkout before creating orders", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: false,
      provider: "none",
    },
    new NoopBillingProvider(),
  );

  await assertRejectsWithBillingCode(
    () =>
      billingService.createPricingCheckout(
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
      ),
    "BILLING_CHECKOUT_DISABLED",
  );
  assert.equal(store.order, null);
});

test("pricing pro checkout ignores missing team provider products", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      creem: {
        ...runtimeConfig.creem,
        teamStandardMonthlyProductId: "",
        teamStandardYearlyProductId: "",
      },
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

  const checkout = await billingService.createPricingCheckout(
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

  assert.equal(checkout.planFamily, "individual_pro");
  assert.equal(checkout.checkoutUrl, "https://checkout.example.test/pro");
});

test("team pricing checkout leaves team empty until fulfillment", async () => {
  const store = new MemoryBillingStore();
  const providerCalls: Array<{
    quantity: number;
    metadata?: Record<string, unknown>;
  }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      teamBillingEnabled: true,
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push({
          quantity: input.quantity,
          metadata: input.metadata,
        });
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
  assert.equal(store.order?.metadata.teamName, undefined);
  assert.equal(providerCalls[0]?.quantity, 2);
  assert.equal(providerCalls[0]?.metadata?.teamName, undefined);
});

test("team pricing checkout uses requested seats and team name", async () => {
  const store = new MemoryBillingStore();
  const providerCalls: Array<{
    quantity: number;
    metadata?: Record<string, unknown>;
  }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      teamBillingEnabled: true,
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push({
          quantity: input.quantity,
          metadata: input.metadata,
        });
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
      billingInterval: "monthly",
      source: "landing",
      teamName: " Launch Lab ",
      seatCount: 6,
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
  );

  assert.equal(checkout.quantity, 6);
  assert.equal(store.order?.quantity, 6);
  assert.equal(store.order?.metadata.teamName, "Launch Lab");
  assert.equal(providerCalls[0]?.quantity, 6);
  assert.equal(providerCalls[0]?.metadata?.teamName, "Launch Lab");
});

test("team pricing checkout is disabled when team billing is disabled", async () => {
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
        throw new Error("provider should not be called");
      },
    },
  );

  await assertRejectsWithBillingCode(
    () =>
      billingService.createPricingCheckout(
        {
          plan: "team",
          billingInterval: "monthly",
          source: "dashboard",
          teamName: "Launch Lab",
        },
        {
          userId: "user_1",
          email: "user@example.com",
        },
      ),
    "TEAM_BILLING_DISABLED",
  );
  assert.equal(store.order, null);
});

test("top-up fulfillment is idempotent and ledger backed", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
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
  assert.equal(topupLedgers[0]?.operationType, "topup");
  assert.equal(topupLedgers[0]?.activityVisible, true);
  assert.equal(topupLedgers[0]?.activityTitle, "Credits top-up purchased");
  assert.equal(topupLedgers[0]?.activitySummary, "+20,000 credits");
  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.equal(store.order?.status, "fulfilled");
});

test("catalog validation catches missing active provider product", async () => {
  assert.throws(
    () =>
      validateBillingCatalog({
        runtimeConfig: {
          ...runtimeConfig,
          saasEnabled: true,
          provider: "creem",
          creem: {
            ...runtimeConfig.creem,
            teamStandardYearlyProductId: "",
          },
        },
      }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "BILLING_CATALOG_INVALID",
      );
      return true;
    },
  );
});
