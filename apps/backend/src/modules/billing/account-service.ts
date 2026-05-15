import type { PoolClient } from "pg";
import {
  getAnchoredMonthlyCycleWindow,
  getPlanQuota,
} from "@sourceweft/credits-core";
import { BillingError } from "./errors";
import {
  appendBillingLedger,
  createOperationId,
  formatSignedLedgerDelta,
} from "./ledger";
import type { BillingStore } from "./store-port";
import type { BillingAccountState, BillingRuntimeConfig } from "./types";
import {
  getTotalPagesBalance,
  getTotalCreditsBalance,
  normalizeTeamId,
} from "./service-helpers";

const ACTIVE_PROVIDER_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "past_due",
]);

function resolvePlanQuota(
  runtimeConfig: BillingRuntimeConfig,
  planFamily: BillingAccountState["planFamily"],
  seatCount = 1,
) {
  const quota = getPlanQuota(planFamily, seatCount);
  if (planFamily !== "individual_free") {
    return quota;
  }

  return {
    ...quota,
    monthlyPagesLimit: runtimeConfig.defaultMonthlyPages,
    monthlyCreditsGrant: runtimeConfig.defaultMonthlyCredits,
  };
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatQuotaRenewalSummary(input: {
  credits: number;
  pages: number;
}) {
  return [
    input.credits > 0 ? formatSignedLedgerDelta("credit", input.credits) : null,
    input.pages > 0 ? formatSignedLedgerDelta("page", input.pages) : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
}

function formatPlanName(planFamily: BillingAccountState["planFamily"]) {
  return planFamily
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export class BillingAccountService {
  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
  ) {}

  async withLockedAccount<T>(
    teamId: string,
    callback: (input: {
      account: BillingAccountState;
      client: PoolClient;
    }) => Promise<T>,
  ) {
    const normalizedTeamId = normalizeTeamId(teamId);

    return this.store.runInTransaction(async (client) => {
      const account = await this.getOrCreateAccountLocked(
        normalizedTeamId,
        client,
      );
      const syncedAccount = await this.syncCycleLocked(account, client);

      return callback({
        account: syncedAccount,
        client,
      });
    });
  }

  async ensureAccountLocked(teamId: string, client: PoolClient) {
    const normalizedTeamId = normalizeTeamId(teamId);
    const account = await this.getOrCreateAccountLocked(
      normalizedTeamId,
      client,
    );
    return this.syncCycleLocked(account, client);
  }

  async updateSpendLimits(
    teamId: string,
    input: { softCapUsd?: number | null; hardCapUsd?: number | null },
  ) {
    return this.withLockedAccount(teamId, async ({ account, client }) => {
      if (input.softCapUsd !== undefined) {
        account.spendSoftCapUsd = input.softCapUsd;
      }

      if (input.hardCapUsd !== undefined) {
        account.spendHardCapUsd = input.hardCapUsd;
      }

      if (
        account.spendSoftCapUsd !== null &&
        account.spendHardCapUsd !== null &&
        account.spendHardCapUsd < account.spendSoftCapUsd
      ) {
        throw new BillingError(
          "INVALID_SPEND_LIMITS",
          400,
          "hardCapUsd must be greater than or equal to softCapUsd",
          {
            softCapUsd: account.spendSoftCapUsd,
            hardCapUsd: account.spendHardCapUsd,
          },
        );
      }

      account.updatedAt = new Date().toISOString();
      await this.store.updateAccount(account, client);

      return {
        teamId: account.teamId,
        softCapUsd: account.spendSoftCapUsd,
        hardCapUsd: account.spendHardCapUsd,
      };
    });
  }

  async applyPlanFamilyLocked(
    account: BillingAccountState,
    nextPlanFamily: typeof account.planFamily,
    client: PoolClient,
    metadata: Record<string, unknown> & { suppressImmediateGrant?: boolean },
  ) {
    if (account.planFamily === nextPlanFamily) {
      return;
    }

    const previousPlanFamily = account.planFamily;
    const previousMonthlyGrant = account.monthlyCreditsGrant;
    const previousMonthlyPagesGrant = account.monthlyPagesGrant;
    const nextQuota = resolvePlanQuota(
      this.runtimeConfig,
      nextPlanFamily,
      account.seatCount,
    );

    account.planFamily = nextPlanFamily;
    account.monthlyCreditsGrant = nextQuota.monthlyCreditsGrant;
    account.monthlyPagesGrant = nextQuota.monthlyPagesLimit;
    account.pagesLimit = account.monthlyPagesGrant;
    account.pagesUsed = account.pagesConsumedThisCycle;
    const operationId = createOperationId(
      "plan-change",
      account.teamId,
      previousPlanFamily,
      nextPlanFamily,
      Date.now(),
    );
    const creditGrantDelta = nextQuota.monthlyCreditsGrant - previousMonthlyGrant;
    const pageGrantDelta = nextQuota.monthlyPagesLimit - previousMonthlyPagesGrant;
    const isCreditPlanActivityVisible =
      !metadata.suppressImmediateGrant &&
      this.runtimeConfig.creditsEnabled &&
      creditGrantDelta > 0;
    const isPagePlanActivityVisible =
      !metadata.suppressImmediateGrant &&
      pageGrantDelta > 0 &&
      !isCreditPlanActivityVisible;
    const activitySummary = `${formatPlanName(previousPlanFamily)} -> ${formatPlanName(
      nextPlanFamily,
    )}`;

    if (
      !metadata.suppressImmediateGrant &&
      creditGrantDelta > 0
    ) {
      const grantDelta = creditGrantDelta;
      account.monthlyCreditsBalance += grantDelta;

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "grant",
          unitType: "credit",
          delta: grantDelta,
          balanceAfter: getTotalCreditsBalance(account),
          feature: "plan_upgrade_grant",
          operationId,
          operationType: "plan_change",
          activityVisible: isCreditPlanActivityVisible,
          activityTitle: "Plan changed",
          activitySummary,
          metadata: {
            ...metadata,
            fromPlanFamily: previousPlanFamily,
            toPlanFamily: nextPlanFamily,
            reason: "plan_upgrade",
          },
        },
      });
    }

    if (
      !metadata.suppressImmediateGrant &&
      pageGrantDelta > 0
    ) {
      const grantDelta = pageGrantDelta;
      account.monthlyPagesBalance += grantDelta;

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "grant",
          unitType: "page",
          delta: grantDelta,
          balanceAfter: getTotalPagesBalance(account),
          feature: "plan_upgrade_grant",
          operationId,
          operationType: "plan_change",
          activityVisible: isPagePlanActivityVisible,
          activityTitle: "Plan changed",
          activitySummary,
          metadata: {
            ...metadata,
            fromPlanFamily: previousPlanFamily,
            toPlanFamily: nextPlanFamily,
            reason: "plan_upgrade",
            previousMonthlyPagesGrant,
            nextMonthlyPagesGrant: nextQuota.monthlyPagesLimit,
            monthlyPagesBalance: account.monthlyPagesBalance,
            addOnPagesBalance: account.addOnPagesBalance,
          },
        },
      });
    }

    account.updatedAt = new Date().toISOString();
    await this.store.updateAccount(account, client);
  }

  async refreshPlanQuotaLocked(
    account: BillingAccountState,
    client: PoolClient,
    metadata: Record<string, unknown>,
  ) {
    const previousMonthlyGrant = account.monthlyCreditsGrant;
    const previousMonthlyPagesGrant = account.monthlyPagesGrant;
    const previousSeatCount = readNumber(metadata.previousSeatCount);
    const nextSeatCount = readNumber(metadata.nextSeatCount) ?? account.seatCount;
    const isSeatChange =
      previousSeatCount !== null && previousSeatCount !== nextSeatCount;
    const operationId =
      typeof metadata.operationId === "string"
        ? metadata.operationId
        : isSeatChange
          ? createOperationId(
              "seat-change",
              account.teamId,
              previousSeatCount,
              nextSeatCount,
              metadata.externalSubscriptionId as string | undefined,
              Date.now(),
            )
          : createOperationId("quota-adjustment", account.teamId, Date.now());
    const nextQuota = resolvePlanQuota(
      this.runtimeConfig,
      account.planFamily,
      account.seatCount,
    );

    if (isSeatChange) {
      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "adjust",
          unitType: "seat",
          delta: nextSeatCount - previousSeatCount,
          balanceAfter: nextSeatCount,
          feature: "seat_quota_change",
          operationId,
          operationType: "seat_change",
          activityVisible: true,
          activityTitle: "Seats updated",
          activitySummary: `${previousSeatCount} -> ${nextSeatCount} seats`,
          metadata: {
            ...metadata,
            previousSeatCount,
            nextSeatCount,
          },
        },
      });
    }

    if (
      account.monthlyCreditsGrant === nextQuota.monthlyCreditsGrant &&
      account.monthlyPagesGrant === nextQuota.monthlyPagesLimit
    ) {
      account.updatedAt = new Date().toISOString();
      await this.store.updateAccount(account, client);
      return;
    }

    account.monthlyCreditsGrant = nextQuota.monthlyCreditsGrant;
    account.monthlyPagesGrant = nextQuota.monthlyPagesLimit;
    account.pagesLimit = account.monthlyPagesGrant;
    account.pagesUsed = account.pagesConsumedThisCycle;

    if (nextQuota.monthlyCreditsGrant > previousMonthlyGrant) {
      const grantDelta = nextQuota.monthlyCreditsGrant - previousMonthlyGrant;
      account.monthlyCreditsBalance += grantDelta;

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "grant",
          unitType: "credit",
          delta: grantDelta,
          balanceAfter: getTotalCreditsBalance(account),
          feature: "seat_quota_grant",
          operationId,
          operationType: isSeatChange ? "seat_change" : "quota_adjustment",
          activityVisible: false,
          metadata: {
            ...metadata,
            reason: "seat_count_increase",
            previousMonthlyGrant,
            nextMonthlyGrant: nextQuota.monthlyCreditsGrant,
          },
        },
      });
    }

    if (nextQuota.monthlyPagesLimit > previousMonthlyPagesGrant) {
      const grantDelta = nextQuota.monthlyPagesLimit - previousMonthlyPagesGrant;
      account.monthlyPagesBalance += grantDelta;

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "grant",
          unitType: "page",
          delta: grantDelta,
          balanceAfter: getTotalPagesBalance(account),
          feature: "seat_quota_grant",
          operationId,
          operationType: isSeatChange ? "seat_change" : "quota_adjustment",
          activityVisible: false,
          metadata: {
            ...metadata,
            reason: "seat_count_increase",
            previousMonthlyPagesGrant,
            nextMonthlyPagesGrant: nextQuota.monthlyPagesLimit,
            monthlyPagesBalance: account.monthlyPagesBalance,
            addOnPagesBalance: account.addOnPagesBalance,
          },
        },
      });
    }

    account.updatedAt = new Date().toISOString();
    await this.store.updateAccount(account, client);
  }

  async realignCycleLocked(
    account: BillingAccountState,
    client: PoolClient,
    input: {
      cycleAnchorAt: string;
      cycleSource: BillingAccountState["cycleSource"];
      cycleStartAt: string;
      cycleEndAt: string;
      metadata: Record<string, unknown>;
      expireCurrentMonthly?: boolean;
      grantNewMonthly?: boolean;
    },
  ) {
    const previousMonthlyBalance = account.monthlyCreditsBalance;
    const previousMonthlyPagesBalance = account.monthlyPagesBalance;
    const previousPagesConsumedThisCycle = account.pagesConsumedThisCycle;
    const expiredCycleSource = account.cycleSource;
    const expiredCycleStartAt = account.cycleStartAt;
    const operationId = createOperationId(
      "cycle-renewal",
      account.teamId,
      input.cycleSource,
      input.cycleStartAt,
    );
    const quota = resolvePlanQuota(
      this.runtimeConfig,
      account.planFamily,
      account.seatCount,
    );

    if (input.expireCurrentMonthly) {
      if (this.runtimeConfig.creditsEnabled && previousMonthlyBalance > 0) {
        account.monthlyCreditsBalance = 0;
        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "expire",
            unitType: "credit",
            delta: -previousMonthlyBalance,
            balanceAfter: getTotalCreditsBalance(account),
            feature: "cycle_expire",
            idempotencyKey: `cycle-expire:${expiredCycleSource}:${expiredCycleStartAt}`,
            operationId,
            operationType: "cycle_renewal",
            activityVisible: false,
            metadata: input.metadata,
          },
        });
      }

      if (this.runtimeConfig.pagesEnabled && previousMonthlyPagesBalance > 0) {
        account.monthlyPagesBalance = 0;
        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "expire",
            unitType: "page",
            delta: -previousMonthlyPagesBalance,
            balanceAfter: getTotalPagesBalance(account),
            feature: "cycle_expire",
            idempotencyKey: `cycle-pages-expire:${expiredCycleSource}:${expiredCycleStartAt}`,
            operationId,
            operationType: "cycle_renewal",
            activityVisible: false,
            metadata: {
              ...input.metadata,
              previousPagesConsumedThisCycle,
              previousMonthlyPagesBalance,
              addOnPagesBalance: account.addOnPagesBalance,
            },
          },
        });
      }
    }

    account.cycleAnchorAt = input.cycleAnchorAt;
    account.cycleSource = input.cycleSource;
    account.cycleStartAt = input.cycleStartAt;
    account.cycleEndAt = input.cycleEndAt;
    account.creditsReserved = 0;
    account.creditsConsumedThisCycle = 0;
    account.monthlyCreditsGrant = quota.monthlyCreditsGrant;
    account.monthlyPagesGrant = quota.monthlyPagesLimit;
    account.pagesConsumedThisCycle = 0;
    account.pagesLimit = quota.monthlyPagesLimit;
    account.pagesUsed = 0;

    if (input.grantNewMonthly) {
      await this.grantCycleBalancesLocked(account, client, quota, {
        ...input.metadata,
        operationId,
      });
    }

    account.updatedAt = new Date().toISOString();
    await this.store.updateAccount(account, client);
  }

  private async getOrCreateAccountLocked(teamId: string, client: PoolClient) {
    const existing = await this.store.getAccountForUpdate(teamId, client);
    if (existing) {
      return existing;
    }

    return this.createDefaultAccountLocked(teamId, client);
  }

  private async createDefaultAccountLocked(teamId: string, client: PoolClient) {
    const quota = resolvePlanQuota(
      this.runtimeConfig,
      this.runtimeConfig.defaultPlanFamily,
    );
    const now = new Date();
    const nowIso = now.toISOString();
    const cycle = getAnchoredMonthlyCycleWindow(now, now);

    const account: BillingAccountState = {
      teamId,
      planFamily: this.runtimeConfig.defaultPlanFamily,
      cycleAnchorAt: nowIso,
      cycleSource: "free_account",
      cycleStartAt: cycle.startAt.toISOString(),
      cycleEndAt: cycle.endAt.toISOString(),
      pagesLimit: quota.monthlyPagesLimit,
      pagesUsed: 0,
      monthlyPagesGrant: quota.monthlyPagesLimit,
      monthlyPagesBalance: quota.monthlyPagesLimit,
      addOnPagesBalance: 0,
      pagesConsumedThisCycle: 0,
      monthlyCreditsGrant: quota.monthlyCreditsGrant,
      monthlyCreditsBalance: quota.monthlyCreditsGrant,
      addOnCreditsBalance: 0,
      creditsReserved: 0,
      creditsConsumedThisCycle: 0,
      seatCount: 1,
      spendSoftCapUsd: null,
      spendHardCapUsd: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.store.insertAccount(account, client);

    if (this.runtimeConfig.pagesEnabled && quota.monthlyPagesLimit > 0) {
      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "grant",
          unitType: "page",
          delta: quota.monthlyPagesLimit,
          balanceAfter: getTotalPagesBalance(account),
          feature: "cycle_grant",
          idempotencyKey: `cycle-pages-grant:${account.cycleSource}:${account.cycleStartAt}`,
          metadata: {
            monthlyPagesGrant: account.monthlyPagesGrant,
            monthlyPagesBalance: account.monthlyPagesBalance,
            addOnPagesBalance: account.addOnPagesBalance,
            consumedThisCycle: account.pagesConsumedThisCycle,
          },
        },
      });
    }

    if (this.runtimeConfig.creditsEnabled && quota.monthlyCreditsGrant > 0) {
      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "grant",
          unitType: "credit",
          delta: quota.monthlyCreditsGrant,
          balanceAfter: getTotalCreditsBalance(account),
          feature: "cycle_grant",
          idempotencyKey: `cycle-grant:${account.cycleSource}:${account.cycleStartAt}`,
        },
      });
    }

    return account;
  }

  private async syncCycleLocked(
    account: BillingAccountState,
    client: PoolClient,
  ) {
    const now = new Date();
    const cycleEnd = new Date(account.cycleEndAt);

    if (now < cycleEnd) {
      return account;
    }

    const subscription = await this.store.getSubscriptionByTeam(
      account.teamId,
      client,
    );

    if (
      account.cycleSource === "provider_subscription" &&
      subscription?.billingInterval === "monthly" &&
      (!subscription.currentPeriodStart ||
        !subscription.currentPeriodEnd ||
        Date.parse(subscription.currentPeriodStart) <=
          Date.parse(account.cycleStartAt))
    ) {
      await this.expireCurrentCycleLocked(account, client, {
        source: "cycle_sync",
        reason: "provider_monthly_renewal_not_confirmed",
        cycleStartAt: account.cycleStartAt,
        cycleEndAt: account.cycleEndAt,
        billingInterval: subscription.billingInterval,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
      });
      return account;
    }

    if (
      account.cycleSource === "provider_subscription" &&
      (!subscription ||
        !ACTIVE_PROVIDER_SUBSCRIPTION_STATUSES.has(subscription.status))
    ) {
      await this.expireCurrentCycleLocked(account, client, {
        source: "cycle_sync",
        reason: "provider_subscription_inactive",
        cycleStartAt: account.cycleStartAt,
        cycleEndAt: account.cycleEndAt,
        subscriptionStatus: subscription?.status ?? null,
      });
      return account;
    }

    if (
      account.cycleSource === "provider_subscription" &&
      subscription?.billingInterval === "unknown"
    ) {
      await this.expireCurrentCycleLocked(account, client, {
        source: "cycle_sync",
        reason: "provider_billing_interval_unknown",
        cycleStartAt: account.cycleStartAt,
        cycleEndAt: account.cycleEndAt,
        subscriptionStatus: subscription.status,
      });
      return account;
    }

    const quota = resolvePlanQuota(
      this.runtimeConfig,
      account.planFamily,
      account.seatCount,
    );
    const isProviderMonthlyCycle =
      account.cycleSource === "provider_subscription" &&
      subscription?.billingInterval === "monthly";
    const isProviderYearlyCycle =
      account.cycleSource === "provider_subscription" &&
      subscription?.billingInterval === "yearly";

    let nextCycle =
      isProviderMonthlyCycle &&
      subscription?.currentPeriodStart &&
      subscription.currentPeriodEnd
        ? {
            startAt: new Date(subscription.currentPeriodStart),
            endAt: new Date(subscription.currentPeriodEnd),
          }
        : getAnchoredMonthlyCycleWindow(
            now,
            isProviderYearlyCycle && subscription?.currentPeriodStart
              ? new Date(subscription.currentPeriodStart)
              : new Date(account.cycleAnchorAt),
          );

    if (
      isProviderYearlyCycle &&
      (!subscription?.currentPeriodStart || !subscription.currentPeriodEnd)
    ) {
      await this.expireCurrentCycleLocked(account, client, {
        source: "cycle_sync",
        reason: "provider_yearly_period_missing",
        cycleStartAt: account.cycleStartAt,
        cycleEndAt: account.cycleEndAt,
      });
      return account;
    }

    if (
      isProviderYearlyCycle &&
      subscription?.currentPeriodStart &&
      nextCycle.startAt < new Date(subscription.currentPeriodStart)
    ) {
      nextCycle = {
        ...nextCycle,
        startAt: new Date(subscription.currentPeriodStart),
      };
    }

    if (
      isProviderYearlyCycle &&
      subscription?.currentPeriodEnd &&
      nextCycle.startAt >= new Date(subscription.currentPeriodEnd)
    ) {
      await this.expireCurrentCycleLocked(account, client, {
        source: "cycle_sync",
        reason: "provider_yearly_period_ended",
        cycleStartAt: account.cycleStartAt,
        cycleEndAt: account.cycleEndAt,
        currentPeriodEnd: subscription.currentPeriodEnd,
      });
      return account;
    }

    if (
      isProviderYearlyCycle &&
      subscription?.currentPeriodEnd &&
      nextCycle.endAt > new Date(subscription.currentPeriodEnd)
    ) {
      nextCycle = {
        ...nextCycle,
        endAt: new Date(subscription.currentPeriodEnd),
      };
    }

    const expiredCycle = {
      source: account.cycleSource,
      startAt: account.cycleStartAt,
    };
    const operationId = createOperationId(
      "cycle-renewal",
      account.teamId,
      account.cycleSource,
      nextCycle.startAt.toISOString(),
    );

    account.cycleStartAt = nextCycle.startAt.toISOString();
    account.cycleEndAt = nextCycle.endAt.toISOString();
    account.creditsReserved = 0;
    account.creditsConsumedThisCycle = 0;
    account.monthlyCreditsGrant = quota.monthlyCreditsGrant;
    account.monthlyPagesGrant = quota.monthlyPagesLimit;
    account.pagesConsumedThisCycle = 0;
    account.pagesLimit = quota.monthlyPagesLimit;
    account.pagesUsed = 0;

    await this.expireAndGrantCycleLocked(
      account,
      client,
      quota,
      {
        source: "cycle_sync",
        cycleStartAt: account.cycleStartAt,
        operationId,
      },
      expiredCycle,
    );

    account.updatedAt = now.toISOString();
    await this.store.updateAccount(account, client);
    return account;
  }

  private async expireAndGrantCycleLocked(
    account: BillingAccountState,
    client: PoolClient,
    quota: ReturnType<typeof getPlanQuota>,
    metadata: Record<string, unknown>,
    expiredCycle: { source: string; startAt: string },
  ) {
    const previousMonthlyBalance = account.monthlyCreditsBalance;
    const previousMonthlyPagesBalance = account.monthlyPagesBalance;
    const previousPagesConsumedThisCycle = account.pagesConsumedThisCycle;

    if (this.runtimeConfig.creditsEnabled) {
      if (previousMonthlyBalance > 0) {
        account.monthlyCreditsBalance = 0;
        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "expire",
            unitType: "credit",
            delta: -previousMonthlyBalance,
            balanceAfter: getTotalCreditsBalance(account),
            feature: "cycle_expire",
            idempotencyKey: `cycle-expire:${expiredCycle.source}:${expiredCycle.startAt}`,
            operationId: metadata.operationId as string | undefined,
            operationType: "cycle_renewal",
            activityVisible: false,
            metadata,
          },
        });
      }
    }

    if (this.runtimeConfig.pagesEnabled) {
      account.monthlyPagesBalance = 0;
      if (previousMonthlyPagesBalance > 0) {
        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "expire",
            unitType: "page",
            delta: -previousMonthlyPagesBalance,
            balanceAfter: getTotalPagesBalance(account),
            feature: "cycle_expire",
            idempotencyKey: `cycle-pages-expire:${expiredCycle.source}:${expiredCycle.startAt}`,
            operationId: metadata.operationId as string | undefined,
            operationType: "cycle_renewal",
            activityVisible: false,
            metadata: {
              ...metadata,
              previousPagesConsumedThisCycle,
              previousMonthlyPagesBalance,
              addOnPagesBalance: account.addOnPagesBalance,
            },
          },
        });
      }
    }

    await this.grantCycleBalancesLocked(account, client, quota, metadata);
  }

  private async expireCurrentCycleLocked(
    account: BillingAccountState,
    client: PoolClient,
    metadata: Record<string, unknown>,
  ) {
    const previousMonthlyBalance = account.monthlyCreditsBalance;
    const previousMonthlyPagesBalance = account.monthlyPagesBalance;
    const previousPagesConsumedThisCycle = account.pagesConsumedThisCycle;

    if (
      previousMonthlyBalance <= 0 &&
      previousMonthlyPagesBalance <= 0 &&
      account.creditsReserved <= 0
    ) {
      return;
    }

    if (this.runtimeConfig.creditsEnabled && previousMonthlyBalance > 0) {
      account.monthlyCreditsBalance = 0;
      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "expire",
          unitType: "credit",
          delta: -previousMonthlyBalance,
          balanceAfter: getTotalCreditsBalance(account),
          feature: "cycle_expire",
          idempotencyKey: `cycle-expire:${account.cycleSource}:${account.cycleStartAt}`,
          operationId: createOperationId(
            "cycle-expire",
            account.teamId,
            account.cycleSource,
            account.cycleStartAt,
          ),
          operationType: "cycle_renewal",
          activityVisible: false,
          metadata,
        },
      });
    }

    if (this.runtimeConfig.pagesEnabled && previousMonthlyPagesBalance > 0) {
      account.monthlyPagesBalance = 0;
      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "expire",
          unitType: "page",
          delta: -previousMonthlyPagesBalance,
          balanceAfter: getTotalPagesBalance(account),
          feature: "cycle_expire",
          idempotencyKey: `cycle-pages-expire:${account.cycleSource}:${account.cycleStartAt}`,
          operationId: createOperationId(
            "cycle-expire",
            account.teamId,
            account.cycleSource,
            account.cycleStartAt,
          ),
          operationType: "cycle_renewal",
          activityVisible: false,
          metadata: {
            ...metadata,
            previousPagesConsumedThisCycle,
            previousMonthlyPagesBalance,
            addOnPagesBalance: account.addOnPagesBalance,
          },
        },
      });
    }

    account.creditsReserved = 0;
    account.updatedAt = new Date().toISOString();
    await this.store.updateAccount(account, client);
  }

  private async grantCycleBalancesLocked(
    account: BillingAccountState,
    client: PoolClient,
    quota: ReturnType<typeof getPlanQuota>,
    metadata: Record<string, unknown>,
  ) {
    const operationId =
      typeof metadata.operationId === "string"
        ? metadata.operationId
        : createOperationId(
            "cycle-renewal",
            account.teamId,
            account.cycleSource,
            account.cycleStartAt,
          );
    const activitySummary = formatQuotaRenewalSummary({
      credits: quota.monthlyCreditsGrant,
      pages: quota.monthlyPagesLimit,
    });
    const isCreditCycleActivityVisible =
      this.runtimeConfig.creditsEnabled && quota.monthlyCreditsGrant > 0;
    const isPageCycleActivityVisible =
      this.runtimeConfig.pagesEnabled &&
      quota.monthlyPagesLimit > 0 &&
      !isCreditCycleActivityVisible;

    if (this.runtimeConfig.creditsEnabled) {
      account.monthlyCreditsBalance = quota.monthlyCreditsGrant;
      if (quota.monthlyCreditsGrant > 0) {
        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "grant",
            unitType: "credit",
            delta: quota.monthlyCreditsGrant,
            balanceAfter: getTotalCreditsBalance(account),
            feature: "cycle_grant",
            idempotencyKey: `cycle-grant:${account.cycleSource}:${account.cycleStartAt}`,
            operationId,
            operationType: "cycle_renewal",
            activityVisible: isCreditCycleActivityVisible,
            activityTitle: "Monthly quota renewed",
            activitySummary,
            metadata,
          },
        });
      }
    }

    if (this.runtimeConfig.pagesEnabled) {
      account.monthlyPagesBalance = quota.monthlyPagesLimit;
      if (quota.monthlyPagesLimit > 0) {
        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "grant",
            unitType: "page",
            delta: quota.monthlyPagesLimit,
            balanceAfter: getTotalPagesBalance(account),
            feature: "cycle_grant",
            idempotencyKey: `cycle-pages-grant:${account.cycleSource}:${account.cycleStartAt}`,
            operationId,
            operationType: "cycle_renewal",
            activityVisible: isPageCycleActivityVisible,
            activityTitle: "Monthly quota renewed",
            activitySummary,
            metadata: {
              ...metadata,
              monthlyPagesGrant: account.monthlyPagesGrant,
              monthlyPagesBalance: account.monthlyPagesBalance,
              addOnPagesBalance: account.addOnPagesBalance,
              consumedThisCycle: account.pagesConsumedThisCycle,
            },
          },
        });
      }
    } else {
      account.monthlyPagesBalance = quota.monthlyPagesLimit;
    }
  }
}
