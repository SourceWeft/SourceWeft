import type { PoolClient } from "pg";
import type {
  BillingSubscriptionResponse,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
} from "@sourceweft/contracts";
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
        const existing = await this.store.getSubscriptionByTeam(
          account.teamId,
          client,
        );
        if (!existing?.externalSubscriptionId) {
          throw new BillingError(
            "SUBSCRIPTION_NOT_FOUND",
            404,
            "No cancellable team subscription found",
          );
        }

        const result = await this.provider.cancelSubscription({
          teamId: account.teamId,
          actorUserId,
          externalSubscriptionId: existing.externalSubscriptionId,
        });

        const snapshot: TeamSubscriptionSnapshot = {
          teamId: account.teamId,
          provider: result.provider,
          planFamily: existing.planFamily,
          status: result.status,
          currentPeriodStart: existing.currentPeriodStart,
          currentPeriodEnd: existing.currentPeriodEnd,
          externalCustomerId: existing.externalCustomerId,
          externalSubscriptionId: existing.externalSubscriptionId,
          externalProductId: existing.externalProductId,
          cancelAtPeriodEnd: result.cancelAtPeriodEnd,
          metadata: {
            ...(existing.metadata ?? {}),
            cancelRequestedBy: actorUserId,
          },
          seatCount: account.seatCount,
        };

        await this.applySubscriptionSnapshotLocked(account, snapshot, client);

        return {
          teamId: account.teamId,
          status: result.status,
          cancelAtPeriodEnd: result.cancelAtPeriodEnd,
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
    await this.store.upsertSubscription(snapshot, client);

    const previousSeatCount = account.seatCount;
    if (snapshot.seatCount !== account.seatCount) {
      account.seatCount = snapshot.seatCount;
    }

    const targetPlan = resolvePlanFromSubscription({
      status: snapshot.status,
      defaultPlanFamily: this.runtimeConfig.defaultPlanFamily,
    });
    if (account.planFamily !== targetPlan) {
      await this.accountService.applyPlanFamilyLocked(
        account,
        targetPlan,
        client,
        {
          source: "subscription",
          provider: snapshot.provider,
          status: snapshot.status,
        },
      );
      return;
    }

    if (previousSeatCount !== account.seatCount) {
      await this.accountService.refreshPlanQuotaLocked(account, client, {
        source: "subscription",
        provider: snapshot.provider,
        status: snapshot.status,
        previousSeatCount,
        nextSeatCount: account.seatCount,
      });
    }
  }
}
