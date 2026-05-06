import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { BillingStore } from "./store-port";
import { BillingAccountService } from "./account-service";
import { BillingUsageService } from "./usage-service";
import type {
  BillingAccountState,
  BillingLedgerRow,
  BillingRuntimeConfig,
  BillingSubscriptionState,
  BillingWebhookEventState,
  BillingWebhookStatus,
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
  cycleAnchorDay: 1,
  reconcileEnabled: false,
  creem: {
    apiKey: "",
    webhookSecret: "",
    testMode: true,
    teamStandardProductId: "",
    defaultSuccessUrl: "http://localhost:3000",
  },
};

class MemoryBillingStore implements BillingStore {
  account: BillingAccountState | null = null;
  ledgers: BillingLedgerRow[] = [];

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
    return 1;
  }

  async getSubscriptionByTeam() {
    return null;
  }

  async upsertSubscription(
    _snapshot: TeamSubscriptionSnapshot,
  ): Promise<BillingSubscriptionState> {
    throw new Error("not implemented");
  }

  async getWebhookEventByProviderEventId() {
    return null;
  }

  async insertWebhookEvent(): Promise<BillingWebhookEventState> {
    throw new Error("not implemented");
  }

  async incrementWebhookEventAttempt(): Promise<BillingWebhookEventState> {
    throw new Error("not implemented");
  }

  async updateWebhookEventState(
    _webhookEventId: string,
    _input: { status: BillingWebhookStatus },
  ): Promise<BillingWebhookEventState> {
    throw new Error("not implemented");
  }

  async listAccountSubscriptionStates() {
    return [];
  }
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
