import type { PoolClient } from "pg";
import {
  getAnchoredMonthlyCycleWindow,
  getPerSeatQuota,
  type PlanQuota,
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
  normalizeUserId,
  resolvePlanFromSubscription,
} from "./service-helpers";

const ACTIVE_PROVIDER_SUBSCRIPTION_STATUSES = new Set(["active", "past_due"]);

/**
 * The quota a single member receives. Grants are per-member now (one
 * `billing_accounts` row per user), so this is one seat's worth regardless of
 * how many seats the team has — a `team_standard` seat is an `individual_pro`
 * allocation. `getPlanQuota` (seat-scaled team total) is only for pricing/catalog.
 */
function resolvePerSeatQuota(
  runtimeConfig: BillingRuntimeConfig,
  planFamily: BillingAccountState["planFamily"],
): PlanQuota {
  const quota = getPerSeatQuota(planFamily);
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

function formatQuotaRenewalSummary(input: { credits: number; pages: number }) {
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

  /**
   * Locks a single member's allocation row for the duration of `callback`.
   * This is the per-actor path (谁问谁付): a member's runs, ingestion, and
   * top-ups move only their own row.
   */
  async withLockedAccount<T>(
    teamId: string,
    userId: string,
    callback: (input: {
      account: BillingAccountState;
      client: PoolClient;
    }) => Promise<T>,
  ) {
    const normalizedTeamId = normalizeTeamId(teamId);
    const normalizedUserId = normalizeUserId(userId);

    return this.store.runInTransaction(async (client) => {
      const account = await this.getOrCreateAccountLocked(
        normalizedTeamId,
        normalizedUserId,
        client,
      );
      const syncedAccount = await this.syncCycleLocked(account, client);

      return callback({
        account: syncedAccount,
        client,
      });
    });
  }

  /**
   * Locks every current member's allocation row for a team-wide operation
   * (plan change, cycle realignment, seat/quota update, spend limits). Ensures a
   * row exists for each Better Auth member first so a newly-activated plan
   * grants everyone their per-seat allocation immediately.
   */
  async withLockedTeamAccounts<T>(
    teamId: string,
    callback: (input: {
      accounts: BillingAccountState[];
      client: PoolClient;
    }) => Promise<T>,
  ) {
    const normalizedTeamId = normalizeTeamId(teamId);

    return this.store.runInTransaction(async (client) => {
      const memberUserIds = await this.store.listTeamMemberUserIds(
        normalizedTeamId,
        client,
      );
      const accounts: BillingAccountState[] = [];
      for (const memberUserId of memberUserIds) {
        const account = await this.getOrCreateAccountLocked(
          normalizedTeamId,
          memberUserId,
          client,
        );
        accounts.push(await this.syncCycleLocked(account, client));
      }

      return callback({ accounts, client });
    });
  }

  async ensureAccountLocked(
    teamId: string,
    userId: string,
    client: PoolClient,
  ) {
    const normalizedTeamId = normalizeTeamId(teamId);
    const normalizedUserId = normalizeUserId(userId);
    const account = await this.getOrCreateAccountLocked(
      normalizedTeamId,
      normalizedUserId,
      client,
    );
    return this.syncCycleLocked(account, client);
  }

  /**
   * Locks a single representative member row for a team-level READ that only
   * needs team attributes (plan, cycle, seat count) — all member rows carry the
   * same team attributes. Prefers an existing row; otherwise materializes the
   * first Better Auth member's row. Team-level MUTATIONS must use
   * {@link withLockedTeamAccounts} so every member's allocation is updated.
   */
  async withRepresentativeTeamAccount<T>(
    teamId: string,
    callback: (input: {
      account: BillingAccountState;
      client: PoolClient;
    }) => Promise<T>,
  ) {
    const normalizedTeamId = normalizeTeamId(teamId);

    return this.store.runInTransaction(async (client) => {
      const existing = await this.store.getAnyTeamAccount(
        normalizedTeamId,
        client,
      );
      let representativeUserId = existing?.userId ?? null;
      if (!representativeUserId) {
        const memberUserIds = await this.store.listTeamMemberUserIds(
          normalizedTeamId,
          client,
        );
        representativeUserId = memberUserIds[0] ?? null;
      }

      if (!representativeUserId) {
        throw new BillingError(
          "TEAM_HAS_NO_MEMBERS",
          409,
          "Team has no members to resolve a billing account for",
          { teamId: normalizedTeamId },
        );
      }

      const account = await this.getOrCreateAccountLocked(
        normalizedTeamId,
        representativeUserId,
        client,
      );
      const syncedAccount = await this.syncCycleLocked(account, client);

      return callback({ account: syncedAccount, client });
    });
  }

  async updateSpendLimits(
    teamId: string,
    input: { softCapUsd?: number | null; hardCapUsd?: number | null },
  ) {
    // Spend caps are a team-level policy applied uniformly to every member row.
    return this.withLockedTeamAccounts(teamId, async ({ accounts, client }) => {
      const nowIso = new Date().toISOString();
      for (const account of accounts) {
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

        account.updatedAt = nowIso;
        await this.store.updateAccount(account, client);
      }

      return {
        teamId: normalizeTeamId(teamId),
        softCapUsd: input.softCapUsd ?? accounts[0]?.spendSoftCapUsd ?? null,
        hardCapUsd: input.hardCapUsd ?? accounts[0]?.spendHardCapUsd ?? null,
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
    const nextQuota = resolvePerSeatQuota(this.runtimeConfig, nextPlanFamily);

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
    const creditGrantDelta =
      nextQuota.monthlyCreditsGrant - previousMonthlyGrant;
    const pageGrantDelta =
      nextQuota.monthlyPagesLimit - previousMonthlyPagesGrant;
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

    if (!metadata.suppressImmediateGrant && creditGrantDelta > 0) {
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

    if (!metadata.suppressImmediateGrant && pageGrantDelta > 0) {
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
    const nextSeatCount =
      readNumber(metadata.nextSeatCount) ?? account.seatCount;
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
    const nextQuota = resolvePerSeatQuota(
      this.runtimeConfig,
      account.planFamily,
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
      const grantDelta =
        nextQuota.monthlyPagesLimit - previousMonthlyPagesGrant;
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
    const quota = resolvePerSeatQuota(this.runtimeConfig, account.planFamily);

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

  private async getOrCreateAccountLocked(
    teamId: string,
    userId: string,
    client: PoolClient,
  ) {
    const existing = await this.store.getAccountForUpdate(
      teamId,
      userId,
      client,
    );
    if (existing) {
      return existing;
    }

    return this.createDefaultAccountLocked(teamId, userId, client);
  }

  /**
   * Resolves the plan and cycle a newly-created member row should inherit. A
   * member joins the team's current plan and aligns to its cycle: prefer an
   * existing sibling member row (already cycle-aligned), else the team's active
   * provider subscription, else the free default.
   */
  private async resolveMemberAccountContext(
    teamId: string,
    client: PoolClient,
  ): Promise<{
    planFamily: BillingAccountState["planFamily"];
    cycleSource: BillingAccountState["cycleSource"];
    cycleAnchorAt: string;
    cycleStartAt: string;
    cycleEndAt: string;
    seatCount: number;
    spendSoftCapUsd: number | null;
    spendHardCapUsd: number | null;
  }> {
    const sibling = await this.store.getAnyTeamAccount(teamId, client);
    if (sibling) {
      return {
        planFamily: sibling.planFamily,
        cycleSource: sibling.cycleSource,
        cycleAnchorAt: sibling.cycleAnchorAt,
        cycleStartAt: sibling.cycleStartAt,
        cycleEndAt: sibling.cycleEndAt,
        seatCount: sibling.seatCount,
        spendSoftCapUsd: sibling.spendSoftCapUsd,
        spendHardCapUsd: sibling.spendHardCapUsd,
      };
    }

    const now = new Date();
    const subscription = await this.store.getSubscriptionByTeam(teamId, client);
    const planFamily = subscription
      ? resolvePlanFromSubscription({
          status: subscription.status,
          planFamily: subscription.planFamily,
          defaultPlanFamily: this.runtimeConfig.defaultPlanFamily,
        })
      : this.runtimeConfig.defaultPlanFamily;

    const isProviderCycle =
      subscription != null &&
      ACTIVE_PROVIDER_SUBSCRIPTION_STATUSES.has(subscription.status) &&
      subscription.currentPeriodStart != null &&
      subscription.currentPeriodEnd != null;

    if (isProviderCycle) {
      return {
        planFamily,
        cycleSource: "provider_subscription",
        cycleAnchorAt: subscription.currentPeriodStart as string,
        cycleStartAt: subscription.currentPeriodStart as string,
        cycleEndAt: subscription.currentPeriodEnd as string,
        // seatCount is a replicated team attribute; the plan-activation fan-out
        // sets the real purchased-seat count on every member row. A lazily
        // created row between activations defaults to 1 (grants don't scale by it).
        seatCount: 1,
        spendSoftCapUsd: null,
        spendHardCapUsd: null,
      };
    }

    const cycle = getAnchoredMonthlyCycleWindow(now, now);
    return {
      planFamily,
      cycleSource: "free_account",
      cycleAnchorAt: now.toISOString(),
      cycleStartAt: cycle.startAt.toISOString(),
      cycleEndAt: cycle.endAt.toISOString(),
      seatCount: 1,
      spendSoftCapUsd: null,
      spendHardCapUsd: null,
    };
  }

  private async createDefaultAccountLocked(
    teamId: string,
    userId: string,
    client: PoolClient,
  ) {
    const context = await this.resolveMemberAccountContext(teamId, client);
    const quota = resolvePerSeatQuota(this.runtimeConfig, context.planFamily);
    const nowIso = new Date().toISOString();

    const account: BillingAccountState = {
      teamId,
      userId,
      planFamily: context.planFamily,
      cycleAnchorAt: context.cycleAnchorAt,
      cycleSource: context.cycleSource,
      cycleStartAt: context.cycleStartAt,
      cycleEndAt: context.cycleEndAt,
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
      seatCount: context.seatCount,
      spendSoftCapUsd: context.spendSoftCapUsd,
      spendHardCapUsd: context.spendHardCapUsd,
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

    const quota = resolvePerSeatQuota(this.runtimeConfig, account.planFamily);
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
    quota: PlanQuota,
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
    quota: PlanQuota,
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
