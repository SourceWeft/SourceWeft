import type { PoolClient } from "pg";
import type {
  BillingSubscriptionResponse,
  BillingSubscriptionStatus,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
  UpdateTeamSubscriptionSeatsRequest,
  UpdateTeamSubscriptionSeatsResponse,
} from "@sourceweft/contracts";
import { getAnchoredMonthlyCycleWindow } from "@sourceweft/credits-core";
import { logger } from "../../shared/logger";
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
  INDIVIDUAL_PRO_PLAN,
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
const TEAM_SEAT_MIN = 2;
const TEAM_SEAT_MAX = 20;

type BillingAlertSink = {
  trigger(input: {
    alertKey: string;
    level: "warn" | "error" | "critical";
    source: string;
    title: string;
    message: string;
    teamId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  resolve(alertKey: string): Promise<unknown>;
};

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
    private readonly alerts?: BillingAlertSink,
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

    if (
      input.planFamily !== TEAM_STANDARD_PLAN &&
      input.planFamily !== INDIVIDUAL_PRO_PLAN
    ) {
      throw new BillingError(
        "UNSUPPORTED_SUBSCRIPTION_PLAN",
        400,
        "Only individual_pro and team_standard subscriptions are available",
      );
    }

    return this.accountService.withLockedAccount(teamId, async ({ account, client }) => {
      const seatCount =
        input.planFamily === TEAM_STANDARD_PLAN
          ? await this.resolveCheckoutSeatCount(account.teamId, input, client)
          : undefined;
      const result = await this.provider.createCheckout({
        teamId: account.teamId,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        planFamily: input.planFamily,
        billingInterval: input.billingInterval,
        seatCount,
        successUrl: input.successUrl,
      });

      return {
        teamId: account.teamId,
        provider: result.provider,
        checkoutUrl: result.checkoutUrl,
      };
    });
  }

  async assertCanInviteTeamMember(teamId: string) {
    await this.assertTeamSeatCapacity(teamId, "invite");
  }

  async assertCanAcceptTeamInvitation(teamId: string) {
    await this.assertTeamSeatCapacity(teamId, "accept_invitation");
  }

  async assertCanAddTeamMember(teamId: string) {
    await this.assertTeamSeatCapacity(teamId, "add_member");
  }

  async syncTeamSubscriptionSeats(
    teamId: string,
    input: UpdateTeamSubscriptionSeatsRequest & {
      actorUserId?: string | null;
      reason?: string;
    },
  ): Promise<UpdateTeamSubscriptionSeatsResponse> {
    ensureTeamBillingEnabled(this.runtimeConfig);

    const operation = await this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        const subscription = await this.store.getSubscriptionByTeam(
          account.teamId,
          client,
        );
        const seatsUsed = await this.store.countTeamMembers(
          account.teamId,
          client,
        );
        const seatCount = this.normalizeRequestedSeatCount(input.seatCount);

        if (seatCount < seatsUsed) {
          throw new BillingError(
            "SEAT_COUNT_BELOW_MEMBERS",
            409,
            "seatCount cannot be lower than current team members",
            {
              seatCount,
              seatsUsed,
            },
          );
        }

        if (
          !subscription ||
          subscription.planFamily !== TEAM_STANDARD_PLAN ||
          !isActiveSubscriptionStatus(subscription.status)
        ) {
          throw new BillingError(
            "TEAM_SUBSCRIPTION_NOT_ACTIVE",
            409,
            "Seat updates require an active team_standard subscription",
          );
        }

        if (!subscription.externalSubscriptionId) {
          throw new BillingError(
            "BILLING_SUBSCRIPTION_ID_MISSING",
            409,
            "No provider subscription ID is available for this team",
          );
        }

        return {
          teamId: account.teamId,
          currentSeatCount: account.seatCount,
          externalSubscriptionId: subscription.externalSubscriptionId,
          seatCount,
          seatsUsed,
        };
      },
    );

    if (operation.currentSeatCount === operation.seatCount) {
      return {
        teamId: operation.teamId,
        provider: this.runtimeConfig.provider,
        seatCount: operation.seatCount,
        seatsUsed: operation.seatsUsed,
      };
    }

    try {
      const providerResult = await this.provider.updateSubscriptionSeats({
        teamId: operation.teamId,
        actorUserId: input.actorUserId,
        externalSubscriptionId: operation.externalSubscriptionId,
        seatCount: operation.seatCount,
      });

      const response = await this.accountService.withLockedAccount(
        operation.teamId,
        async ({ account, client }) => {
          const seatsUsed = await this.store.countTeamMembers(
            account.teamId,
            client,
          );

          if (operation.seatCount < seatsUsed) {
            throw new BillingError(
              "SEAT_COUNT_BELOW_MEMBERS",
              409,
              "seatCount cannot be lower than current team members",
              {
                seatCount: operation.seatCount,
                seatsUsed,
              },
            );
          }

          const previousSeatCount = account.seatCount;
          account.seatCount = operation.seatCount;
          await this.accountService.refreshPlanQuotaLocked(account, client, {
            source: "seat_sync",
            provider: providerResult.provider,
            externalSubscriptionId: operation.externalSubscriptionId,
            reason: input.reason ?? "seat_count_update",
            previousSeatCount,
            nextSeatCount: account.seatCount,
          });

          return {
            teamId: account.teamId,
            provider: providerResult.provider,
            seatCount: account.seatCount,
            seatsUsed,
          };
        },
      );

      await this.resolveSeatSyncAlert(operation.teamId);
      return response;
    } catch (error) {
      await this.triggerSeatSyncAlert(operation, error);
      throw error;
    }
  }

  async syncTeamSubscriptionSeatsToMembers(
    teamId: string,
    input?: {
      actorUserId?: string | null;
      reason?: string;
    },
  ): Promise<UpdateTeamSubscriptionSeatsResponse | null> {
    if (!this.runtimeConfig.teamBillingEnabled) {
      return null;
    }

    const operation = await this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        const subscription = await this.store.getSubscriptionByTeam(
          account.teamId,
          client,
        );

        if (
          !subscription ||
          subscription.planFamily !== TEAM_STANDARD_PLAN ||
          !isActiveSubscriptionStatus(subscription.status)
        ) {
          return null;
        }

        const seatsUsed = await this.store.countTeamMembers(
          account.teamId,
          client,
        );
        const seatCount = Math.max(TEAM_SEAT_MIN, seatsUsed);
        return {
          seatCount,
          currentSeatCount: account.seatCount,
        };
      },
    );

    if (operation === null) {
      return null;
    }

    if (operation.seatCount === operation.currentSeatCount) {
      return null;
    }

    return this.syncTeamSubscriptionSeats(teamId, {
      seatCount: operation.seatCount,
      actorUserId: input?.actorUserId,
      reason: input?.reason ?? "member_count_changed",
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
      planFamily: snapshot.planFamily,
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

  private normalizeRequestedSeatCount(value: number) {
    const seatCount = Math.floor(value);
    if (
      !Number.isFinite(seatCount) ||
      seatCount < TEAM_SEAT_MIN ||
      seatCount > TEAM_SEAT_MAX
    ) {
      throw new BillingError(
        "INVALID_SEAT_COUNT",
        400,
        `seatCount must be between ${TEAM_SEAT_MIN} and ${TEAM_SEAT_MAX}`,
      );
    }

    return seatCount;
  }

  private async resolveCheckoutSeatCount(
    teamId: string,
    input: CreateTeamSubscriptionCheckoutRequest,
    client: PoolClient,
  ) {
    const requested = input.seatCount;
    if (requested === undefined) {
      throw new BillingError(
        "SEAT_COUNT_REQUIRED",
        400,
        "seatCount is required for team_standard subscriptions",
      );
    }

    const seatCount = this.normalizeRequestedSeatCount(requested);
    const seatsUsed = await this.store.countTeamMembers(teamId, client);
    if (seatCount < seatsUsed) {
      throw new BillingError(
        "SEAT_COUNT_BELOW_MEMBERS",
        409,
        "seatCount cannot be lower than current team members",
        {
          seatCount,
          seatsUsed,
        },
      );
    }

    return seatCount;
  }

  private async assertTeamSeatCapacity(
    teamId: string,
    mode: "invite" | "accept_invitation" | "add_member",
  ) {
    if (!this.runtimeConfig.teamBillingEnabled) {
      return;
    }

    await this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        const subscription = await this.store.getSubscriptionByTeam(
          account.teamId,
          client,
        );

        if (
          !subscription ||
          subscription.planFamily !== TEAM_STANDARD_PLAN ||
          !isActiveSubscriptionStatus(subscription.status)
        ) {
          return;
        }

        const seatsUsed = await this.store.countTeamMembers(
          account.teamId,
          client,
        );
        const pendingInvites = await this.store.countPendingTeamInvitations(
          account.teamId,
          client,
        );
        const allocatedSeats =
          mode === "add_member" ? seatsUsed : seatsUsed + pendingInvites;
        const limitReached =
          mode === "accept_invitation"
            ? allocatedSeats > account.seatCount
            : allocatedSeats >= account.seatCount;

        if (!limitReached) {
          return;
        }

        throw new BillingError(
          "TEAM_SEAT_LIMIT_REACHED",
          409,
          "Team seat limit reached. Add seats in billing before adding more members.",
          {
            seatCount: account.seatCount,
            seatsUsed,
            pendingInvites,
            mode,
          },
        );
      },
    );
  }

  private seatSyncAlertKey(teamId: string) {
    return `billing:seat-sync:failed:${teamId}`;
  }

  private async triggerSeatSyncAlert(
    operation: {
      teamId: string;
      currentSeatCount: number;
      externalSubscriptionId: string;
      seatCount: number;
      seatsUsed: number;
    },
    error: unknown,
  ) {
    if (!this.alerts) {
      return;
    }

    try {
      await this.alerts.trigger({
        alertKey: this.seatSyncAlertKey(operation.teamId),
        level: "error",
        source: "billing.seats",
        title: "Team subscription seat sync failed",
        message:
          error instanceof Error
            ? error.message
            : "Unknown provider seat sync error",
        teamId: operation.teamId,
        metadata: {
          currentSeatCount: operation.currentSeatCount,
          requestedSeatCount: operation.seatCount,
          seatsUsed: operation.seatsUsed,
          externalSubscriptionId: operation.externalSubscriptionId,
        },
      });
    } catch (alertError) {
      logger.error("Failed to emit billing seat sync alert", {
        teamId: operation.teamId,
        error:
          alertError instanceof Error ? alertError.message : String(alertError),
      });
    }
  }

  private async resolveSeatSyncAlert(teamId: string) {
    if (!this.alerts) {
      return;
    }

    await this.alerts.resolve(this.seatSyncAlertKey(teamId)).catch(() => null);
  }
}
