import type { PoolClient } from "pg";
import type {
  BillingSubscriptionResponse,
  BillingSubscriptionStatus,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
} from "@sourceweft/contracts";
import { getAnchoredMonthlyCycleWindow } from "@sourceweft/credits-core";
import { BillingAccountService } from "./account-service";
import { BillingError } from "./errors";
import type { BillingStore } from "./store-port";
import type {
  BillingAccountState,
  BillingProviderAdapter,
  BillingRuntimeConfig,
  TeamSubscriptionSnapshot,
} from "./types";
import {
  TEAM_STANDARD_PLAN,
  ensureTeamBillingEnabled,
  resolvePlanFromSubscription,
  toSubscriptionSummary,
} from "./service-helpers";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  "trialing",
  "active",
  "past_due",
]);

function isActiveSubscriptionStatus(status: BillingSubscriptionStatus) {
  return ACTIVE_SUBSCRIPTION_STATUSES.has(status);
}

function parseProviderPeriod(snapshot: TeamSubscriptionSnapshot) {
  if (!snapshot.currentPeriodStart || !snapshot.currentPeriodEnd) {
    return null;
  }

  const startAt = new Date(snapshot.currentPeriodStart);
  const endAt = new Date(snapshot.currentPeriodEnd);
  if (
    Number.isNaN(startAt.getTime()) ||
    Number.isNaN(endAt.getTime()) ||
    endAt <= startAt
  ) {
    return null;
  }

  return { startAt, endAt };
}

function sameInstant(left: string, right: string) {
  return Date.parse(left) === Date.parse(right);
}

function getProviderCycleWindow(
  snapshot: TeamSubscriptionSnapshot,
  period: { startAt: Date; endAt: Date },
  now: Date,
) {
  if (snapshot.billingInterval === "monthly") {
    return {
      anchorAt: period.startAt,
      cycleStartAt: period.startAt,
      cycleEndAt: period.endAt,
    };
  }

  if (snapshot.billingInterval === "yearly") {
    const cycle = getAnchoredMonthlyCycleWindow(now, period.startAt);
    const cycleStartAt =
      cycle.startAt < period.startAt ? period.startAt : cycle.startAt;
    const cycleEndAt = cycle.endAt > period.endAt ? period.endAt : cycle.endAt;

    if (cycleStartAt >= period.endAt || cycleEndAt <= cycleStartAt) {
      return null;
    }

    return {
      anchorAt: period.startAt,
      cycleStartAt,
      cycleEndAt,
    };
  }

  return null;
}

export class BillingSubscriptionService {
  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    private readonly provider: BillingProviderAdapter,
    private readonly accountService: BillingAccountService,
  ) {}

  async getSubscription(teamId: string): Promise<BillingSubscriptionResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        const subscription = await this.store.getSubscriptionByTeam(
          account.teamId,
          client,
        );

        return toSubscriptionSummary({
          account,
          subscription,
          provider: this.runtimeConfig.provider,
        });
      },
    );
  }

  async createSubscriptionCheckout(
    teamId: string,
    input: CreateTeamSubscriptionCheckoutRequest,
    actor: { userId: string; email: string },
  ): Promise<CreateTeamSubscriptionCheckoutResponse> {
    ensureTeamBillingEnabled(this.runtimeConfig);

    if (input.planFamily !== TEAM_STANDARD_PLAN) {
      throw new BillingError(
        "UNSUPPORTED_TEAM_PLAN",
        400,
        "Only team_standard is available in this release",
      );
    }

    return this.accountService.withLockedAccount(teamId, async ({ account }) => {
      const result = await this.provider.createCheckout({
        teamId: account.teamId,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        planFamily: input.planFamily,
        seatCount: input.seatCount,
        successUrl: input.successUrl,
      });

      return {
        teamId: account.teamId,
        provider: result.provider,
        checkoutUrl: result.checkoutUrl,
      };
    });
  }

  async createBillingPortal(
    teamId: string,
    actorUserId: string,
  ): Promise<CreateTeamBillingPortalResponse> {
    ensureTeamBillingEnabled(this.runtimeConfig);

    return this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        const subscription = await this.store.getSubscriptionByTeam(
          account.teamId,
          client,
        );

        if (!subscription) {
          throw new BillingError(
            "SUBSCRIPTION_NOT_FOUND",
            404,
            "No active team subscription found",
          );
        }

        if (!subscription.externalCustomerId) {
          throw new BillingError(
            "BILLING_CUSTOMER_NOT_FOUND",
            409,
            "No billing customer is available for this team subscription",
          );
        }

        const result = await this.provider.createPortal({
          teamId: account.teamId,
          actorUserId,
          externalCustomerId: subscription.externalCustomerId,
        });

        return {
          teamId: account.teamId,
          provider: result.provider,
          portalUrl: result.portalUrl,
        };
      },
    );
  }

  async cancelSubscription(
    teamId: string,
    actorUserId: string,
  ): Promise<CancelTeamSubscriptionResponse> {
    ensureTeamBillingEnabled(this.runtimeConfig);

    return this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        const subscription = await this.store.getSubscriptionByTeam(
          account.teamId,
          client,
        );

        if (!subscription) {
          throw new BillingError(
            "SUBSCRIPTION_NOT_FOUND",
            404,
            "No team subscription found",
          );
        }

        if (!subscription.externalCustomerId) {
          throw new BillingError(
            "BILLING_CUSTOMER_NOT_FOUND",
            409,
            "No billing customer is available for this team subscription",
          );
        }

        const result = await this.provider.createPortal({
          teamId: account.teamId,
          actorUserId,
          externalCustomerId: subscription.externalCustomerId,
        });

        return {
          teamId: account.teamId,
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          portalUrl: result.portalUrl,
        };
      },
    );
  }

  async syncSubscriptionSnapshot(snapshot: TeamSubscriptionSnapshot) {
    ensureTeamBillingEnabled(this.runtimeConfig);

    return this.accountService.withLockedAccount(
      snapshot.teamId,
      async ({ account, client }) => {
        await this.applySubscriptionSnapshotLocked(account, snapshot, client);
        return toSubscriptionSummary({
          account,
          subscription: await this.store.getSubscriptionByTeam(
            account.teamId,
            client,
          ),
          provider: this.runtimeConfig.provider,
        });
      },
    );
  }

  private async applySubscriptionSnapshotLocked(
    account: BillingAccountState,
    snapshot: TeamSubscriptionSnapshot,
    client: PoolClient,
  ) {
    const targetPlan = resolvePlanFromSubscription({
      status: snapshot.status,
      defaultPlanFamily: this.runtimeConfig.defaultPlanFamily,
    });
    const now = new Date();
    const metadata = {
      source: "subscription",
      provider: snapshot.provider,
      status: snapshot.status,
      billingInterval: snapshot.billingInterval,
      externalSubscriptionId: snapshot.externalSubscriptionId,
      currentPeriodStart: snapshot.currentPeriodStart,
      currentPeriodEnd: snapshot.currentPeriodEnd,
    };

    const period = parseProviderPeriod(snapshot);
    const providerCycle = period
      ? getProviderCycleWindow(snapshot, period, now)
      : null;

    if (
      isActiveSubscriptionStatus(snapshot.status) &&
      (!period || !providerCycle || providerCycle.cycleEndAt <= now)
    ) {
      throw new BillingError(
        "INVALID_PROVIDER_SUBSCRIPTION_PERIOD",
        422,
        "Active subscription snapshot is missing a usable provider period",
        {
          billingInterval: snapshot.billingInterval,
          currentPeriodStart: snapshot.currentPeriodStart,
          currentPeriodEnd: snapshot.currentPeriodEnd,
        },
      );
    }

    await this.store.upsertSubscription(snapshot, client);

    if (!isActiveSubscriptionStatus(snapshot.status)) {
      const previousSeatCount = account.seatCount;
      const planChanged = account.planFamily !== targetPlan;
      account.seatCount = snapshot.seatCount;

      if (planChanged) {
        await this.accountService.applyPlanFamilyLocked(
          account,
          targetPlan,
          client,
          {
            ...metadata,
            suppressImmediateGrant: true,
          },
        );
      }

      const shouldRealignFreeCycle =
        planChanged ||
        account.cycleSource === "provider_subscription" ||
        now >= new Date(account.cycleEndAt);

      if (shouldRealignFreeCycle) {
        const freeAnchorAt = now;
        const freeCycle = getAnchoredMonthlyCycleWindow(now, freeAnchorAt);
        await this.accountService.realignCycleLocked(account, client, {
          cycleAnchorAt: freeAnchorAt.toISOString(),
          cycleSource: "free_account",
          cycleStartAt: freeCycle.startAt.toISOString(),
          cycleEndAt: freeCycle.endAt.toISOString(),
          expireCurrentMonthly: true,
          grantNewMonthly: true,
          metadata: {
            ...metadata,
            reason: "subscription_inactive",
          },
        });
        return;
      }

      if (previousSeatCount !== account.seatCount) {
        await this.accountService.refreshPlanQuotaLocked(account, client, {
          ...metadata,
          previousSeatCount,
          nextSeatCount: account.seatCount,
        });
      }

      return;
    }

    if (!providerCycle) {
      throw new BillingError(
        "INVALID_PROVIDER_SUBSCRIPTION_PERIOD",
        422,
        "Active subscription snapshot is missing a usable provider period",
        {
          billingInterval: snapshot.billingInterval,
          currentPeriodStart: snapshot.currentPeriodStart,
          currentPeriodEnd: snapshot.currentPeriodEnd,
        },
      );
    }

    const activeProviderCycle = providerCycle;
    const previousSeatCount = account.seatCount;
    const planChanged = account.planFamily !== targetPlan;
    account.seatCount = snapshot.seatCount;

    if (planChanged) {
      await this.accountService.applyPlanFamilyLocked(
        account,
        targetPlan,
        client,
        {
          ...metadata,
          suppressImmediateGrant: true,
        },
      );
    }

    const nextCycleStartAt = activeProviderCycle.cycleStartAt.toISOString();
    const nextCycleEndAt = activeProviderCycle.cycleEndAt.toISOString();
    const nextCycleAnchorAt = activeProviderCycle.anchorAt.toISOString();
    const alreadyAligned =
      account.cycleSource === "provider_subscription" &&
      sameInstant(account.cycleAnchorAt, nextCycleAnchorAt) &&
      sameInstant(account.cycleStartAt, nextCycleStartAt) &&
      sameInstant(account.cycleEndAt, nextCycleEndAt);

    if (!alreadyAligned) {
      await this.accountService.realignCycleLocked(account, client, {
        cycleAnchorAt: nextCycleAnchorAt,
        cycleSource: "provider_subscription",
        cycleStartAt: nextCycleStartAt,
        cycleEndAt: nextCycleEndAt,
        expireCurrentMonthly: true,
        grantNewMonthly: true,
        metadata: {
          ...metadata,
          reason: "provider_period_confirmed",
        },
      });
      return;
    }

    if (previousSeatCount !== account.seatCount) {
      await this.accountService.refreshPlanQuotaLocked(account, client, {
        ...metadata,
        previousSeatCount,
        nextSeatCount: account.seatCount,
      });
    }
  }
}
