import { prepareSubscriptionFact } from "./subscription-lifecycle";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  BillingSubscriptionResponse,
  BillingSubscriptionStatus,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  PreviewTeamSubscriptionSeatsResponse,
  TeamSubscriptionSeatBillingAdjustment,
  TeamSubscriptionSeatQuotaAdjustment,
  UpdateTeamSubscriptionSeatsRequest,
  UpdateTeamSubscriptionSeatsResponse,
} from "@sourceweft/contracts";
import { getAnchoredMonthlyCycleWindow } from "@sourceweft/credits-core";
import type { BillingLogger } from "./host";
import { BillingAccountService } from "./account-service";
import { BillingError } from "./errors";
import { appendBillingLedger, createOperationId } from "./ledger";
import type { BillingStore } from "./store-port";
import type {
  BillingAccountState,
  BillingProviderAdapter,
  BillingRuntimeConfig,
  TeamSubscriptionSnapshot,
} from "./types";
import { clawbackMonthlyPages, getTotalPagesBalance } from "./page-ledger";
import {
  INDIVIDUAL_PRO_PLAN,
  TEAM_STANDARD_PLAN,
  clawbackMonthlyCredits,
  ensureTeamBillingEnabled,
  getTotalCreditsBalance,
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

/**
 * Purchase-flow layer: the provider-billed subscription's lifecycle after (and
 * beside) checkout.
 *
 * Owns everything that keeps a team's local plan state faithful to the
 * provider's subscription record: applying webhook snapshots (with stale/
 * unusable-period rejection so a bad snapshot never rewrites a cycle), seat
 * count changes (provider update first, local quota only after it succeeds,
 * clawback on downgrade), seat-capacity gates for invites/joins, portal and
 * cancellation. Team-wide changes fan out over every member row via
 * `account-service.withLockedTeamAccounts`, since plan attributes are
 * replicated per member.
 *
 * Dependencies point downward — plan/cycle/quota transitions go through
 * `account-service`'s locked lifecycle methods, ledger rows through `ledger`,
 * and both halves of `applySeatQuotaClawbackLocked` debit through a ledger
 * primitive (`clawbackMonthlyCredits` / `clawbackMonthlyPages`) rather than
 * editing bucket state here. This layer never meters usage and never reads the
 * settle funnel;
 * `webhook-service` and `service` (the facade) are its only callers.
 */
export class BillingSubscriptionService {
  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    private readonly provider: BillingProviderAdapter,
    private readonly accountService: BillingAccountService,
    private readonly alerts?: BillingAlertSink,
    private readonly logger?: BillingLogger,
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
    const seatCount = this.normalizeRequestedSeatCount(input.seatCount);
    const targetKey = `team:${teamId}`;
    const reserved = await this.accountService.withRepresentativeTeamAccount(
      teamId,
      async ({ account, client }) => {
        const subscription = await this.store.getSubscriptionByTeam(
          teamId,
          client,
        );
        const seatsUsed = await this.store.countTeamMembers(teamId, client);
        const pendingInvitations = await this.store.countPendingTeamInvitations(
          teamId,
          client,
        );
        this.assertSeatUpdateAllowed({
          currentSeatCount: account.seatCount,
          seatCount,
          seatsUsed,
          pendingInvitations,
        });
        if (
          !subscription ||
          subscription.planFamily !== TEAM_STANDARD_PLAN ||
          subscription.status !== "active" ||
          !subscription.externalSubscriptionId
        )
          throw new BillingError(
            "TEAM_SUBSCRIPTION_NOT_ACTIVE",
            409,
            "Seat updates require an active team subscription",
          );
        if (subscription.provider !== this.runtimeConfig.provider)
          throw new BillingError(
            "BILLING_PROVIDER_MISMATCH",
            409,
            "Manage seats through the original provider",
          );
        const preview = calculateSeatPreview({
          account,
          subscription,
          runtimeConfig: this.runtimeConfig,
          seatCount,
          seatsUsed,
          pendingInvitations,
          provider: subscription.provider,
        });
        const open = await this.store.getOpenSubscriptionOperation(
          targetKey,
          client,
        );
        const requestHash = JSON.stringify([
          subscription.currentBindingId ?? subscription.externalSubscriptionId,
          seatCount,
        ]);
        if (
          open &&
          (open.kind !== "seats" ||
            open.requestHash !== requestHash ||
            open.status === "remote_pending")
        )
          throw new BillingError(
            "SUBSCRIPTION_OPERATION_CONFLICT",
            409,
            "Another subscription operation is unresolved",
          );
        if (account.seatCount === seatCount && !open)
          return { subscription, preview, operation: null };
        const operation = open ?? {
          id: randomUUID(),
          targetKey,
          kind: "seats" as const,
          requestHash,
          orderId: null,
          status: "reserved" as const,
          metadata: { bindingId: subscription.currentBindingId, seatCount },
        };
        await this.store.saveSubscriptionOperation(
          { ...operation, status: "remote_pending" },
          client,
        );
        return { subscription, preview, operation };
      },
    );
    if (!reserved.operation)
      return {
        ...reserved.preview,
        quotaAdjustment: null,
        billingAdjustment: null,
      };
    try {
      // The network operation runs after committing the reservation, without row locks.
      const result = await this.provider.updateSubscriptionSeats({
        teamId,
        actorUserId: input.actorUserId,
        externalSubscriptionId: reserved.subscription.externalSubscriptionId!,
        externalProductId: reserved.subscription.externalProductId,
        seatCount,
        updateBehavior: toProviderUpdateBehavior(
          reserved.preview.billingAdjustment?.providerAction ?? "none",
        ),
      });
      const response = await this.accountService.withLockedTeamAccounts(
        teamId,
        async ({ accounts, client }) => {
          const current = await this.store.getSubscriptionByTeam(
            teamId,
            client,
          );
          if (
            !current ||
            current.currentBindingId !==
              reserved.subscription.currentBindingId ||
            current.externalSubscriptionId !==
              reserved.subscription.externalSubscriptionId ||
            current.status !== "active"
          )
            throw new BillingError(
              "SUBSCRIPTION_BINDING_CONFLICT",
              409,
              "Subscription changed during seat update",
            );
          const seatsUsed = await this.store.countTeamMembers(teamId, client);
          const pendingInvitations =
            await this.store.countPendingTeamInvitations(teamId, client);
          this.assertSeatUpdateAllowed({
            currentSeatCount: accounts[0]?.seatCount ?? seatCount,
            seatCount,
            seatsUsed,
            pendingInvitations,
          });
          for (const account of accounts) {
            const previousSeatCount = account.seatCount;
            account.seatCount = result.seatCount;
            await this.accountService.refreshPlanQuotaLocked(account, client, {
              source: "seat_sync",
              provider: result.provider,
              previousSeatCount,
              nextSeatCount: account.seatCount,
              operationId: reserved.operation!.id,
              reason: input.reason ?? "seat_count_update",
            });
          }
          await this.store.upsertSubscription(
            {
              ...current,
              version: (current.version ?? 0) + 1,
              seatCount,
              metadata: { ...current.metadata, seatCount },
            },
            client,
          );
          await this.store.saveSubscriptionOperation(
            { ...reserved.operation!, status: "succeeded" },
            client,
          );
          return {
            ...reserved.preview,
            seatsUsed,
            pendingInvitations,
            seatCount: result.seatCount,
          };
        },
      );
      await this.resolveSeatSyncAlert(teamId);
      return response;
    } catch (error) {
      await this.store.runInTransaction(async (client) => {
        await this.store.lockSubscriptionTarget(targetKey, client);
        const open = await this.store.getOpenSubscriptionOperation(
          targetKey,
          client,
        );
        if (open?.id === reserved.operation!.id)
          await this.store.saveSubscriptionOperation(
            { ...open, status: "needs_resolution" },
            client,
          );
      });
      await this.triggerSeatSyncAlert(
        {
          teamId,
          currentSeatCount: reserved.preview.currentSeatCount,
          externalSubscriptionId: reserved.subscription.externalSubscriptionId!,
          seatCount,
          seatsUsed: reserved.preview.seatsUsed,
        },
        error,
      );
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

  private async portalContext(teamId: string, actorUserId: string) {
    return this.accountService.withRepresentativeTeamAccount(
      teamId,
      async ({ client }) => {
        const subscription = await this.store.getSubscriptionByTeam(
          teamId,
          client,
        );
        if (!subscription)
          throw new BillingError(
            "SUBSCRIPTION_NOT_FOUND",
            404,
            "No billing subscription found",
          );
        if (
          subscription.provider !== this.runtimeConfig.provider ||
          !["creem", "waffo", "stripe"].includes(subscription.provider)
        )
          throw new BillingError(
            "BILLING_PROVIDER_MISMATCH",
            409,
            "Manage this subscription through its original source",
          );
        if (
          !subscription.externalCustomerId &&
          !subscription.externalSubscriptionId
        )
          throw new BillingError(
            "BILLING_CUSTOMER_NOT_FOUND",
            409,
            "No payment customer is bound to this subscription",
          );
        return {
          subscription,
          input: {
            teamId,
            actorUserId,
            externalCustomerId: subscription.externalCustomerId,
            externalSubscriptionId: subscription.externalSubscriptionId,
          },
        };
      },
    );
  }

  async createBillingPortal(
    teamId: string,
    actorUserId: string,
  ): Promise<CreateTeamBillingPortalResponse> {
    const context = await this.portalContext(teamId, actorUserId);
    const result = await this.provider.createPortal(context.input);
    return { teamId, provider: result.provider, portalUrl: result.portalUrl };
  }

  async cancelSubscription(
    teamId: string,
    actorUserId: string,
  ): Promise<CancelTeamSubscriptionResponse> {
    const context = await this.portalContext(teamId, actorUserId);
    const result = await this.provider.createPortal(context.input);
    // Opening the portal never changes local cancellation state.
    return {
      teamId,
      status: context.subscription.status,
      cancelAtPeriodEnd: context.subscription.cancelAtPeriodEnd,
      portalUrl: result.portalUrl,
    };
  }

  async syncSubscriptionSnapshot(snapshot: TeamSubscriptionSnapshot) {
    return this.store.runInTransaction((client) =>
      this.applySubscriptionSnapshotLocked(snapshot, client),
    );
  }

  async applySubscriptionSnapshotLocked(
    input: TeamSubscriptionSnapshot,
    client: PoolClient,
    establish = false,
  ) {
    const snapshot = await prepareSubscriptionFact(
      this.store,
      input,
      client,
      establish,
    );
    if (!snapshot) return null;
    const prepared = await this.prepareSubscriptionSnapshotLocked(
      snapshot,
      client,
    );
    // Status-only observations never issue or refresh an allocation.
    if (
      snapshot.status === "past_due" ||
      (snapshot.status === "active" && !snapshot.confirmCoverage && !establish)
    )
      return snapshot;
    const userIds = (
      await this.store.listTeamMemberUserIds(snapshot.teamId, client)
    ).sort();
    for (const userId of userIds) {
      const account = await this.accountService.ensureAccountLocked(
        snapshot.teamId,
        userId,
        client,
      );
      await this.applySubscriptionSnapshotToAccountLocked(
        account,
        snapshot,
        prepared,
        client,
      );
    }
    return snapshot;
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
      subscriptionBindingId: snapshot.currentBindingId,
      provider: snapshot.provider,
      status: snapshot.status,
      billingInterval: snapshot.billingInterval,
      externalSubscriptionId: snapshot.externalSubscriptionId,
      currentPeriodStart: snapshot.currentPeriodStart,
      currentPeriodEnd: snapshot.currentPeriodEnd,
    };

    const period = parseProviderPeriod({
      ...snapshot,
      currentPeriodStart: snapshot.confirmedPeriodStart ?? null,
      currentPeriodEnd: snapshot.confirmedPeriodEnd ?? null,
    });
    const providerCycle = period
      ? getProviderCycleWindow(snapshot, period, now)
      : null;

    if (
      snapshot.status === "active" &&
      snapshot.confirmCoverage === true &&
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
      account.cycleSource ===
        (snapshot.provider === "manual" ? "manual" : "provider_subscription") &&
      sameInstant(account.cycleAnchorAt, nextCycleAnchorAt) &&
      sameInstant(account.cycleStartAt, nextCycleStartAt) &&
      sameInstant(account.cycleEndAt, nextCycleEndAt);

    if (!alreadyAligned) {
      await this.accountService.realignCycleLocked(account, client, {
        cycleAnchorAt: nextCycleAnchorAt,
        cycleSource:
          snapshot.provider === "manual" ? "manual" : "provider_subscription",
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
    // Both debits go through their ledger primitive (clamp + debit in one
    // step); the returned amounts drive the ledger rows and dirty check below.
    const creditsToClawback = clawbackMonthlyCredits(
      account,
      input.quotaAdjustment.actualCredits,
    );
    const pagesToClawback = clawbackMonthlyPages(
      account,
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
        // Serialize every seat-capacity check for this team. Without this,
        // N concurrent invite/accept/add requests each read the same
        // pre-write committed snapshot, all pass, and together overrun the
        // paid seatCount (a read-then-write TOCTOU). A transaction-scoped
        // advisory lock keyed on the teamId makes the count-read + decision
        // below mutually exclusive per team; it releases automatically when
        // this transaction commits. (Mirrors the two-arg hashtext lock
        // pattern used by the workspace store.)
        //
        // Residual race: Better Auth performs the actual seat-consuming write
        // (invitation/member INSERT) in a SEPARATE, later transaction that is
        // outside this lock's hold, so a narrow window remains between this
        // locked check committing and that INSERT committing. Fully closing it
        // would require wrapping Better Auth's write in this same locked
        // transaction, which its 1.6.10 API does not expose. This lock removes
        // the dominant, easily-triggered check-vs-check overrun.
        //
        // Guarded on raw-SQL capability: the in-memory store used in tests has
        // no real connection (and, being single-process, no advisory-lock
        // semantics to enforce), so there is nothing to serialize there.
        if (typeof client.query === "function") {
          await client.query(
            "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
            ["sourceweft:team-seat-capacity", account.teamId],
          );
        }

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
      this.logger?.error("Failed to emit billing seat sync alert", {
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
