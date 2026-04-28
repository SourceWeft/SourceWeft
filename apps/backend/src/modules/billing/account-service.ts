import type { PoolClient } from "pg";
import { getMonthlyCycleWindow, getPlanQuota } from "@sourceweft/credits-core";
import { BillingError } from "./errors";
import { appendBillingLedger } from "./ledger";
import type { BillingStore } from "./store-port";
import type { BillingAccountState, BillingRuntimeConfig } from "./types";
import {
  getPagesRemaining,
  getTotalCreditsBalance,
  normalizeTeamId,
} from "./service-helpers";

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
    metadata: Record<string, unknown>,
  ) {
    if (account.planFamily === nextPlanFamily) {
      return;
    }

    const previousPlanFamily = account.planFamily;
    const previousMonthlyGrant = account.monthlyCreditsGrant;
    const previousPagesLimit = account.pagesLimit;
    const nextQuota = getPlanQuota(nextPlanFamily, account.seatCount);

    account.planFamily = nextPlanFamily;
    account.monthlyCreditsGrant = nextQuota.monthlyCreditsGrant;
    account.pagesLimit = Math.max(
      nextQuota.monthlyPagesLimit,
      account.pagesUsed,
    );

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
          feature: "plan_upgrade_grant",
          metadata: {
            ...metadata,
            fromPlanFamily: previousPlanFamily,
            toPlanFamily: nextPlanFamily,
            reason: "plan_upgrade",
          },
        },
      });
    }

    if (account.pagesLimit !== previousPagesLimit) {
      const pagesLimitDelta = account.pagesLimit - previousPagesLimit;

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "adjust",
          unitType: "page",
          delta: pagesLimitDelta,
          balanceAfter: getPagesRemaining(account),
          feature: "plan_change",
          metadata: {
            ...metadata,
            fromPlanFamily: previousPlanFamily,
            toPlanFamily: nextPlanFamily,
            previousPagesLimit,
            nextPagesLimit: account.pagesLimit,
            pagesUsed: account.pagesUsed,
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
    const previousPagesLimit = account.pagesLimit;
    const nextQuota = getPlanQuota(account.planFamily, account.seatCount);
    const nextPagesLimit = Math.max(
      nextQuota.monthlyPagesLimit,
      account.pagesUsed,
    );

    if (
      account.monthlyCreditsGrant === nextQuota.monthlyCreditsGrant &&
      account.pagesLimit === nextPagesLimit
    ) {
      account.updatedAt = new Date().toISOString();
      await this.store.updateAccount(account, client);
      return;
    }

    account.monthlyCreditsGrant = nextQuota.monthlyCreditsGrant;
    account.pagesLimit = nextPagesLimit;

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
          metadata: {
            ...metadata,
            reason: "seat_count_increase",
            previousMonthlyGrant,
            nextMonthlyGrant: nextQuota.monthlyCreditsGrant,
          },
        },
      });
    }

    if (account.pagesLimit !== previousPagesLimit) {
      const pagesLimitDelta = account.pagesLimit - previousPagesLimit;

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "adjust",
          unitType: "page",
          delta: pagesLimitDelta,
          balanceAfter: getPagesRemaining(account),
          feature: "seat_quota_change",
          metadata: {
            ...metadata,
            previousPagesLimit,
            nextPagesLimit: account.pagesLimit,
            pagesUsed: account.pagesUsed,
          },
        },
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
    const quota = getPlanQuota(this.runtimeConfig.defaultPlanFamily);
    const now = new Date();
    const cycle = getMonthlyCycleWindow(now, this.runtimeConfig.cycleAnchorDay);
    const nowIso = now.toISOString();

    const account: BillingAccountState = {
      teamId,
      planFamily: this.runtimeConfig.defaultPlanFamily,
      cycleAnchorDay: this.runtimeConfig.cycleAnchorDay,
      cycleStartAt: cycle.startAt.toISOString(),
      cycleEndAt: cycle.endAt.toISOString(),
      pagesLimit: quota.monthlyPagesLimit,
      pagesUsed: 0,
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
          balanceAfter: getPagesRemaining(account),
          feature: "cycle_grant",
          idempotencyKey: `cycle-pages-grant:${account.cycleStartAt}`,
          metadata: {
            pageLimit: account.pagesLimit,
            pagesUsed: account.pagesUsed,
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
          idempotencyKey: `cycle-grant:${account.cycleStartAt}`,
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

    const quota = getPlanQuota(account.planFamily, account.seatCount);
    const nextCycle = getMonthlyCycleWindow(now, account.cycleAnchorDay);
    const previousMonthlyBalance = account.monthlyCreditsBalance;
    const previousPagesUsed = account.pagesUsed;
    const previousPagesRemaining = getPagesRemaining(account);

    account.cycleStartAt = nextCycle.startAt.toISOString();
    account.cycleEndAt = nextCycle.endAt.toISOString();
    account.pagesLimit = quota.monthlyPagesLimit;
    account.pagesUsed = 0;
    account.creditsReserved = 0;
    account.creditsConsumedThisCycle = 0;
    account.monthlyCreditsGrant = quota.monthlyCreditsGrant;

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
            idempotencyKey: `cycle-expire:${account.cycleStartAt}`,
          },
        });
      }

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
            idempotencyKey: `cycle-grant:${account.cycleStartAt}`,
          },
        });
      }
    }

    if (this.runtimeConfig.pagesEnabled) {
      if (previousPagesRemaining > 0) {
        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "expire",
            unitType: "page",
            delta: -previousPagesRemaining,
            balanceAfter: 0,
            feature: "cycle_expire",
            idempotencyKey: `cycle-pages-expire:${account.cycleStartAt}`,
            metadata: {
              previousPagesUsed,
              previousPagesRemaining,
            },
          },
        });
      }

      if (account.pagesLimit > 0) {
        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "grant",
            unitType: "page",
            delta: account.pagesLimit,
            balanceAfter: getPagesRemaining(account),
            feature: "cycle_grant",
            idempotencyKey: `cycle-pages-grant:${account.cycleStartAt}`,
            metadata: {
              pageLimit: account.pagesLimit,
              pagesUsed: account.pagesUsed,
            },
          },
        });
      }
    }

    account.updatedAt = now.toISOString();
    await this.store.updateAccount(account, client);
    return account;
  }
}
