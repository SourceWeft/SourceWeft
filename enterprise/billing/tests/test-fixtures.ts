// Shared in-memory fixtures for the billing module's service-level tests.
// Moved verbatim out of `page-ledger.test.ts` when that file was split by
// subject; the test bodies that use them were not changed.
import assert from "node:assert/strict";
import { type PoolClient } from "pg";
import { type BillingStore } from "../src/server/store-port";
import {
  type BillingAccountState,
  type BillingLedgerRow,
  type BillingOrderState,
  type BillingRuntimeConfig,
  type BillingSubscriptionState,
  type BillingWebhookEventState,
  type BillingWebhookStatus,
  type BillingProviderAdapter,
  type TeamSubscriptionSnapshot,
} from "../src/server/types";

export const client = {} as PoolClient;

export const runtimeConfig: BillingRuntimeConfig = {
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

export class MemoryBillingStore implements BillingStore {
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

  async getTeamAccountsForUpdate() {
    return this.account ? [this.account] : [];
  }

  async getAnyTeamAccount() {
    return this.account;
  }

  async listTeamMemberUserIds() {
    return this.account ? [this.account.userId] : ["user_1"];
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

export const noopProvider: BillingProviderAdapter = {
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

export function createActiveTeamAccount(
  overrides: Partial<BillingAccountState> = {},
): BillingAccountState {
  const now = new Date().toISOString();

  return {
    teamId: "team_1",
    userId: "user_1",
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

export function createActiveTeamSubscription(
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

export async function assertRejectsWithBillingCode(
  action: () => Promise<unknown>,
  code: string,
) {
  await assert.rejects(action, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}
