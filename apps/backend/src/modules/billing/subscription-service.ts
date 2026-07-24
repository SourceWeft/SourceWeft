import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  BillingSubscriptionResponse,
  BillingSubscriptionStatus,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
  PreviewTeamSubscriptionSeatsResponse,
  TeamSubscriptionSeatBillingAdjustment,
  TeamSubscriptionSeatQuotaAdjustment,
  UpdateTeamSubscriptionSeatsRequest,
  UpdateTeamSubscriptionSeatsResponse,
} from "@sourceweft/contracts";
import { getAnchoredMonthlyCycleWindow } from "@sourceweft/credits-core";
import { logger } from "../../shared/logger";
import { BillingAccountService } from "./account-service";
import { resolveSubscriptionProduct } from "./catalog";
import { BillingError } from "./errors";
import { appendBillingLedger, createOperationId } from "./ledger";
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
  ensureBillingCheckoutEnabled,
  ensureTeamBillingEnabled,
  getTotalCreditsBalance,
  getTotalPagesBalance,
  resolvePlanFromSubscription,
  toSubscriptionSummary,
} from "./service-helpers";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  "active",
  "past_due",
]);
const TEAM_SEAT_MIN = 2;
const TEAM_SEAT_MAX = 99;

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

function getOrderCustomerId(
  order: { externalCustomerId: string | null } | null | undefined,
) {
  return order?.externalCustomerId ?? null;
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

function roundNonNegative(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.round(value);
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function resolveSeatUnitPriceCents(input: {
  runtimeConfig: BillingRuntimeConfig;
  subscription: { billingInterval: string | null };
}) {
  if (input.subscription.billingInterval === "monthly") {
    return input.runtimeConfig.catalog.teamStandardMonthlyAmountCents;
  }

  if (input.subscription.billingInterval === "yearly") {
    return input.runtimeConfig.catalog.teamStandardYearlyAmountCents;
  }

  return input.runtimeConfig.catalog.teamStandardMonthlyAmountCents;
}

function resolveRemainingCycleRatio(input: {
  account: BillingAccountState;
  subscription: {
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
  };
  now: Date;
}) {
  const start = input.subscription.currentPeriodStart
    ? new Date(input.subscription.currentPeriodStart)
    : new Date(input.account.cycleStartAt);
  const end = input.subscription.currentPeriodEnd
    ? new Date(input.subscription.currentPeriodEnd)
    : new Date(input.account.cycleEndAt);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start ||
    input.now >= end
  ) {
    return 0;
  }

  const remaining =
    end.getTime() - Math.max(input.now.getTime(), start.getTime());
  const total = end.getTime() - start.getTime();
  return clampRatio(remaining / total);
}

function resolveSeatBillingProviderAction(input: {
  currentSeatCount: number;
  seatCount: number;
  refundRatio: number;
}) {
  if (input.seatCount > input.currentSeatCount) {
    return "proration_charge_immediately" as const;
  }

  if (input.seatCount < input.currentSeatCount) {
    return input.refundRatio >= 1
      ? ("proration_credit" as const)
      : ("internal_partial_credit" as const);
  }

  return "none" as const;
}

function toProviderUpdateBehavior(
  action: TeamSubscriptionSeatBillingAdjustment["providerAction"],
) {
  if (action === "proration_charge_immediately") {
    return "proration-charge-immediately" as const;
  }

  if (action === "proration_credit") {
    return "proration-charge" as const;
  }

  return "proration-none" as const;
}

function calculateSeatPreview(input: {
  account: BillingAccountState;
  subscription: {
    billingInterval: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
  };
  runtimeConfig: BillingRuntimeConfig;
  seatCount: number;
  seatsUsed: number;
  pendingInvitations: number;
  provider: BillingRuntimeConfig["provider"];
}): PreviewTeamSubscriptionSeatsResponse {
  const removedSeats = Math.max(0, input.account.seatCount - input.seatCount);
  const addedSeats = Math.max(0, input.seatCount - input.account.seatCount);
  const remainingRatio =
    removedSeats > 0 || addedSeats > 0
      ? resolveRemainingCycleRatio({
          account: input.account,
          subscription: input.subscription,
          now: new Date(),
        })
      : 0;
  // Per-member billing: a removed seat removes that member's own allocation row;
  // remaining members keep their full per-seat quota, so there is no shared pool
  // to claw back. The seat's money is refunded at full proration.
  const refundRatio = 1;
  const unitPriceCents = resolveSeatUnitPriceCents({
    runtimeConfig: input.runtimeConfig,
    subscription: input.subscription,
  });
  const theoreticalRefundCents = roundNonNegative(
    removedSeats * unitPriceCents * remainingRatio,
  );
  const actualRefundCents = roundNonNegative(
    theoreticalRefundCents * refundRatio,
  );
  const estimatedChargeCents = roundNonNegative(
    addedSeats * unitPriceCents * remainingRatio,
  );
  const providerAction = resolveSeatBillingProviderAction({
    currentSeatCount: input.account.seatCount,
    seatCount: input.seatCount,
    refundRatio,
  });

  return {
    teamId: input.account.teamId,
    provider: input.provider,
    currentSeatCount: input.account.seatCount,
    seatCount: input.seatCount,
    seatsUsed: input.seatsUsed,
    pendingInvitations: input.pendingInvitations,
    // No monthly-quota clawback under per-member billing (see refundRatio note).
    quotaAdjustment: null,
    billingAdjustment:
      removedSeats > 0 || input.seatCount !== input.account.seatCount
        ? {
            theoreticalRefundCents,
            actualRefundCents,
            unrefundedCents: Math.max(
              theoreticalRefundCents - actualRefundCents,
              0,
            ),
            estimatedChargeCents,
            currency: "usd",
            providerAction,
          }
        : null,
  };
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
    return this.accountService.withRepresentativeTeamAccount(
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
    ensureBillingCheckoutEnabled(this.runtimeConfig);
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

    return this.accountService.withRepresentativeTeamAccount(
      teamId,
      async ({ account, client }) => {
        const seatCount =
          input.planFamily === TEAM_STANDARD_PLAN
            ? await this.resolveCheckoutSeatCount(account.teamId, input, client)
            : undefined;
        const product = resolveSubscriptionProduct({
          runtimeConfig: this.runtimeConfig,
          planFamily: input.planFamily,
          billingInterval: input.billingInterval,
        });
        const result = await this.provider.createCheckout({
          orderId: `legacy-subscription:${randomUUID()}`,
          kind: "subscription",
          teamId: account.teamId,
          actorUserId: actor.userId,
          actorEmail: actor.email,
          planFamily: input.planFamily,
          billingInterval: input.billingInterval,
          quantity: seatCount ?? 1,
          externalProductId: product.productId,
          amountTotal: product.amountCents * (seatCount ?? 1),
          currency: product.currency,
          successUrl: input.successUrl,
          metadata: {
            teamId: account.teamId,
            referenceId: actor.userId,
            seatCount: seatCount ?? 1,
          },
        });

        return {
          teamId: account.teamId,
          provider: result.provider,
          checkoutUrl: result.checkoutUrl,
        };
      },
    );
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

  async previewTeamSubscriptionSeats(
    teamId: string,
    input: UpdateTeamSubscriptionSeatsRequest,
  ): Promise<PreviewTeamSubscriptionSeatsResponse> {
    ensureTeamBillingEnabled(this.runtimeConfig);

    return this.accountService.withRepresentativeTeamAccount(
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
        const pendingInvitations = await this.store.countPendingTeamInvitations(
          account.teamId,
          client,
        );
        const seatCount = this.normalizeRequestedSeatCount(input.seatCount);

        this.assertSeatUpdateAllowed({
          currentSeatCount: account.seatCount,
          seatCount,
          seatsUsed,
          pendingInvitations,
        });

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

        return calculateSeatPreview({
          account,
          subscription,
          runtimeConfig: this.runtimeConfig,
          seatCount,
          seatsUsed,
          pendingInvitations,
          provider: this.runtimeConfig.provider,
        });
      },
    );
  }

  async syncTeamSubscriptionSeats(
    teamId: string,
    input: UpdateTeamSubscriptionSeatsRequest & {
      actorUserId?: string | null;
      reason?: string;
    },
  ): Promise<UpdateTeamSubscriptionSeatsResponse> {
    ensureTeamBillingEnabled(this.runtimeConfig);

    let alertOperation: {
      teamId: string;
      currentSeatCount: number;
      externalSubscriptionId: string;
      seatCount: number;
      seatsUsed: number;
    } | null = null;

    try {
      const response = await this.accountService.withLockedTeamAccounts(
        teamId,
        async ({ accounts, client }) => {
          // All member rows mirror the team's seat/plan attributes; use the
          // first row as the representative for team-level reads and validation.
          const representative = accounts[0];
          if (!representative) {
            throw new BillingError(
              "TEAM_HAS_NO_MEMBERS",
              409,
              "Team has no members to resolve a billing account for",
              { teamId },
            );
          }
          const subscription = await this.store.getSubscriptionByTeam(
            representative.teamId,
            client,
          );
          const seatsUsed = await this.store.countTeamMembers(
            representative.teamId,
            client,
          );
          const pendingInvitations =
            await this.store.countPendingTeamInvitations(
              representative.teamId,
              client,
            );
          const seatCount = this.normalizeRequestedSeatCount(input.seatCount);

          this.assertSeatUpdateAllowed({
            currentSeatCount: representative.seatCount,
            seatCount,
            seatsUsed,
            pendingInvitations,
          });

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

          const preview = calculateSeatPreview({
            account: representative,
            subscription,
            runtimeConfig: this.runtimeConfig,
            seatCount,
            seatsUsed,
            pendingInvitations,
            provider: this.runtimeConfig.provider,
          });
          alertOperation = {
            teamId: representative.teamId,
            currentSeatCount: representative.seatCount,
            externalSubscriptionId: subscription.externalSubscriptionId,
            seatCount,
            seatsUsed,
          };

          if (representative.seatCount === seatCount) {
            return {
              teamId: representative.teamId,
              provider: this.runtimeConfig.provider,
              seatCount,
              seatsUsed,
              pendingInvitations,
              quotaAdjustment: null,
              billingAdjustment: null,
            };
          }

          // The provider seat change is a single team-level side effect.
          const providerAction =
            preview.billingAdjustment?.providerAction ?? "none";
          const providerResult = await this.provider.updateSubscriptionSeats({
            teamId: representative.teamId,
            actorUserId: input.actorUserId,
            externalSubscriptionId: subscription.externalSubscriptionId,
            externalProductId: subscription.externalProductId,
            seatCount,
            updateBehavior: toProviderUpdateBehavior(providerAction),
          });
          const previousSeatCount = representative.seatCount;
          const operationId = createOperationId(
            "seat-change",
            representative.teamId,
            previousSeatCount,
            seatCount,
            subscription.externalSubscriptionId,
            Date.now(),
          );

          // Apply the seat change, quota refresh and any clawback to every
          // member row so each member's allocation is updated identically.
          // The clawback is recomputed per member because it clamps to that
          // member's own credit/page balances.
          for (const account of accounts) {
            // Compute this member's clawback from its pre-mutation balances,
            // mirroring the original ordering (preview before quota refresh).
            const accountPreview = calculateSeatPreview({
              account,
              subscription,
              runtimeConfig: this.runtimeConfig,
              seatCount,
              seatsUsed,
              pendingInvitations,
              provider: this.runtimeConfig.provider,
            });

            account.seatCount = seatCount;
            await this.accountService.refreshPlanQuotaLocked(account, client, {
              source: "seat_sync",
              provider: providerResult.provider,
              externalSubscriptionId: subscription.externalSubscriptionId,
              reason: input.reason ?? "seat_count_update",
              previousSeatCount,
              nextSeatCount: account.seatCount,
              operationId,
            });

            if (accountPreview.quotaAdjustment) {
              await this.applySeatQuotaClawbackLocked(account, client, {
                quotaAdjustment: accountPreview.quotaAdjustment,
                billingAdjustment: accountPreview.billingAdjustment,
                actorUserId: input.actorUserId,
                externalSubscriptionId: subscription.externalSubscriptionId,
                previousSeatCount,
                nextSeatCount: account.seatCount,
                reason: input.reason ?? "seat_count_update",
                operationId,
              });
            }
          }

          return {
            teamId: representative.teamId,
            provider: providerResult.provider,
            seatCount: representative.seatCount,
            seatsUsed,
            pendingInvitations,
            quotaAdjustment: preview.quotaAdjustment ?? null,
            billingAdjustment: preview.billingAdjustment ?? null,
          };
        },
      );

      await this.resolveSeatSyncAlert(response.teamId);
      return response;
    } catch (error) {
      if (alertOperation) {
        await this.triggerSeatSyncAlert(alertOperation, error);
      }
      throw error;
    }
  }

  async syncTeamSubscriptionSeatsToMembers(
    _teamId: string,
    _input?: {
      actorUserId?: string | null;
      reason?: string;
    },
  ): Promise<UpdateTeamSubscriptionSeatsResponse | null> {
    return null;
  }

  async createBillingPortal(
    teamId: string,
    actorUserId: string,
  ): Promise<CreateTeamBillingPortalResponse> {
    ensureTeamBillingEnabled(this.runtimeConfig);

    return this.accountService.withRepresentativeTeamAccount(
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
            "No billing subscription found",
          );
        }

        const customerId = await this.resolvePortalCustomerId(
          subscription,
          actorUserId,
          client,
        );

        if (!customerId && !subscription.externalSubscriptionId) {
          throw new BillingError(
            "BILLING_CUSTOMER_NOT_FOUND",
            409,
            "No billing customer is available for this subscription",
          );
        }

        const result = await this.provider.createPortal({
          teamId: account.teamId,
          actorUserId,
          externalCustomerId: customerId,
          externalSubscriptionId: subscription.externalSubscriptionId,
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

    return this.accountService.withRepresentativeTeamAccount(
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
            "No billing subscription found",
          );
        }

        const customerId = await this.resolvePortalCustomerId(
          subscription,
          actorUserId,
          client,
        );

        if (!customerId && !subscription.externalSubscriptionId) {
          throw new BillingError(
            "BILLING_CUSTOMER_NOT_FOUND",
            409,
            "No billing customer is available for this subscription",
          );
        }

        const result = await this.provider.createPortal({
          teamId: account.teamId,
          actorUserId,
          externalCustomerId: customerId,
          externalSubscriptionId: subscription.externalSubscriptionId,
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

  private async resolvePortalCustomerId(
    subscription: {
      billingOrderId: string | null;
      externalCustomerId: string | null;
    },
    actorUserId: string,
    client: PoolClient,
  ) {
    if (subscription.externalCustomerId) {
      return subscription.externalCustomerId;
    }

    const subscriptionOrder = subscription.billingOrderId
      ? await this.store.getOrderById(subscription.billingOrderId, client)
      : null;
    const userSubscription =
      await this.store.getLatestCustomerSubscriptionByUser(actorUserId, client);
    const userOrder = await this.store.getLatestCustomerOrderByUser(
      actorUserId,
      client,
    );

    return (
      getOrderCustomerId(subscriptionOrder) ??
      userSubscription?.externalCustomerId ??
      getOrderCustomerId(userOrder)
    );
  }

  async syncSubscriptionSnapshot(snapshot: TeamSubscriptionSnapshot) {
    if (snapshot.planFamily === TEAM_STANDARD_PLAN) {
      ensureTeamBillingEnabled(this.runtimeConfig);
    }

    return this.accountService.withLockedTeamAccounts(
      snapshot.teamId,
      async ({ accounts, client }) => {
        // Validate the snapshot period and upsert the subscription record once
        // per team; the per-account mutation is then applied to every member.
        const prepared = await this.prepareSubscriptionSnapshotLocked(
          snapshot,
          client,
        );
        for (const account of accounts) {
          await this.applySubscriptionSnapshotToAccountLocked(
            account,
            snapshot,
            prepared,
            client,
          );
        }

        const representative = accounts[0];
        if (!representative) {
          throw new BillingError(
            "TEAM_HAS_NO_MEMBERS",
            409,
            "Team has no members to resolve a billing account for",
            { teamId: snapshot.teamId },
          );
        }
        return toSubscriptionSummary({
          account: representative,
          subscription: await this.store.getSubscriptionByTeam(
            representative.teamId,
            client,
          ),
          provider: this.runtimeConfig.provider,
        });
      },
    );
  }

  private async prepareSubscriptionSnapshotLocked(
    snapshot: TeamSubscriptionSnapshot,
    client: PoolClient,
  ): Promise<{
    targetPlan: BillingAccountState["planFamily"];
    now: Date;
    metadata: Record<string, unknown>;
    providerCycle: {
      anchorAt: Date;
      cycleStartAt: Date;
      cycleEndAt: Date;
    } | null;
  }> {
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

    return { targetPlan, now, metadata, providerCycle };
  }

  private async applySubscriptionSnapshotToAccountLocked(
    account: BillingAccountState,
    snapshot: TeamSubscriptionSnapshot,
    prepared: {
      targetPlan: BillingAccountState["planFamily"];
      now: Date;
      metadata: Record<string, unknown>;
      providerCycle: {
        anchorAt: Date;
        cycleStartAt: Date;
        cycleEndAt: Date;
      } | null;
    },
    client: PoolClient,
  ) {
    const { targetPlan, now, metadata, providerCycle } = prepared;

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

  private assertSeatUpdateAllowed(input: {
    currentSeatCount: number;
    seatCount: number;
    seatsUsed: number;
    pendingInvitations: number;
  }) {
    const allocatedSeats = input.seatsUsed + input.pendingInvitations;

    if (
      input.seatCount < input.currentSeatCount &&
      input.seatsUsed >= input.currentSeatCount
    ) {
      throw new BillingError(
        "SEAT_COUNT_FILLED_BY_MEMBERS",
        409,
        "Remove a team member before reducing seats.",
        input,
      );
    }

    if (input.seatCount < allocatedSeats) {
      throw new BillingError(
        "SEAT_COUNT_BELOW_ALLOCATED_SEATS",
        409,
        "seatCount cannot be lower than current team members and pending invitations",
        {
          ...input,
          allocatedSeats,
        },
      );
    }
  }

  private async applySeatQuotaClawbackLocked(
    account: BillingAccountState,
    client: PoolClient,
    input: {
      quotaAdjustment: TeamSubscriptionSeatQuotaAdjustment;
      billingAdjustment: TeamSubscriptionSeatBillingAdjustment | null;
      actorUserId?: string | null;
      externalSubscriptionId: string;
      previousSeatCount: number;
      nextSeatCount: number;
      reason: string;
      operationId: string;
    },
  ) {
    const creditsToClawback = Math.min(
      account.monthlyCreditsBalance,
      input.quotaAdjustment.actualCredits,
    );
    const pagesToClawback = Math.min(
      account.monthlyPagesBalance,
      input.quotaAdjustment.actualPages,
    );
    const clawbackMetadata = {
      reason: input.reason,
      previousSeatCount: input.previousSeatCount,
      nextSeatCount: input.nextSeatCount,
      externalSubscriptionId: input.externalSubscriptionId,
      targetClawback: {
        credits: input.quotaAdjustment.targetCredits,
        pages: input.quotaAdjustment.targetPages,
      },
      actualClawback: {
        credits: input.quotaAdjustment.actualCredits,
        pages: input.quotaAdjustment.actualPages,
      },
      refundRatio: input.quotaAdjustment.refundRatio,
      quotaAdjustment: input.quotaAdjustment,
      billingAdjustment: input.billingAdjustment,
    };

    if (creditsToClawback > 0) {
      account.monthlyCreditsBalance -= creditsToClawback;
      account.updatedAt = new Date().toISOString();

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "adjust",
          unitType: "credit",
          delta: -creditsToClawback,
          balanceAfter: getTotalCreditsBalance(account),
          feature: "seat_quota_clawback",
          actorUserId: input.actorUserId ?? undefined,
          operationId: input.operationId,
          operationType: "seat_change",
          activityVisible: false,
          metadata: clawbackMetadata,
        },
      });
    }

    if (pagesToClawback > 0) {
      account.monthlyPagesBalance -= pagesToClawback;
      account.updatedAt = new Date().toISOString();

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "adjust",
          unitType: "page",
          delta: -pagesToClawback,
          balanceAfter: getTotalPagesBalance(account),
          feature: "seat_quota_clawback",
          actorUserId: input.actorUserId ?? undefined,
          operationId: input.operationId,
          operationType: "seat_change",
          activityVisible: false,
          metadata: clawbackMetadata,
        },
      });
    }

    if (creditsToClawback > 0 || pagesToClawback > 0) {
      await this.store.updateAccount(account, client);
    }
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
    const pendingInvitations = await this.store.countPendingTeamInvitations(
      teamId,
      client,
    );
    const allocatedSeats = seatsUsed + pendingInvitations;
    if (seatCount < allocatedSeats) {
      throw new BillingError(
        "SEAT_COUNT_BELOW_ALLOCATED_SEATS",
        409,
        "seatCount cannot be lower than current team members and pending invitations",
        {
          seatCount,
          seatsUsed,
          pendingInvitations,
          allocatedSeats,
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

    const result = await this.accountService.withRepresentativeTeamAccount(
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
        const pendingInvitations = await this.store.countPendingTeamInvitations(
          account.teamId,
          client,
        );
        const allocatedSeats = seatsUsed + pendingInvitations;
        const requestedSeats =
          mode === "accept_invitation" ? allocatedSeats : allocatedSeats + 1;

        if (requestedSeats <= account.seatCount) {
          return null;
        }

        return {
          seatCount: account.seatCount,
          seatsUsed,
          pendingInvitations,
          allocatedSeats,
          requestedSeats,
        };
      },
    );

    if (result === null) {
      return;
    }

    throw new BillingError(
      "TEAM_SEAT_LIMIT_REACHED",
      409,
      "No team seats are available. Add seats before inviting or adding another member.",
      {
        ...result,
        mode,
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
