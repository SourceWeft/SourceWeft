import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  computeCreditsFromCost,
  getMonthlyCycleWindow,
  getPlanQuota,
  resolveIngestionPages,
  toUsdFromCredits,
  type LedgerEventType,
  type LedgerUnitType,
} from "@sourceweft/credits-core";
import type {
  BillingSubscriptionResponse,
  BillingSubscriptionStatus,
  BillingLedgerEntry,
  BillingLedgerResponse,
  BillingSummaryResponse,
  BillingUsageItem,
  BillingUsageResponse,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
  CreateTopupCheckoutRequest,
  CreateTopupCheckoutResponse,
  MeterConsumeRequest,
  MeterConsumeResponse,
  MeterIngestionRequest,
  MeterIngestionResponse,
  UpdateSpendLimitsRequest,
  UpdateSpendLimitsResponse,
} from "@sourceweft/contracts";
import { BillingError } from "./errors";
import { PostgresBillingStore } from "./store";
import type {
  BillingAccountState,
  BillingProviderAdapter,
  BillingRuntimeConfig,
  BillingSubscriptionState,
  BillingWebhookProcessInput,
  BillingWebhookProcessResult,
  TeamSubscriptionSnapshot,
  TeamPlanReconcileAnomaly,
  TeamPlanReconcileResult,
} from "./types";

type LedgerWriteInput = {
  eventType: LedgerEventType;
  unitType: LedgerUnitType;
  delta: number;
  balanceAfter: number;
  feature: string;
  actorUserId?: string;
  workspaceId?: string;
  referenceId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

const DEFAULT_CONSUME_FEATURE = "chat";
const DEFAULT_INGESTION_FEATURE = "ingestion";
const TEAM_STANDARD_PLAN = "team_standard" as const;

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  "trialing",
  "active",
  "past_due",
]);

export class BillingService {
  constructor(
    private readonly store: PostgresBillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    private readonly provider: BillingProviderAdapter,
  ) {}

  async ensureBillingAccount(teamId: string) {
    return this.withLockedAccount(teamId, async ({ account }) => account);
  }

  async getSummary(teamId: string): Promise<BillingSummaryResponse> {
    return this.withLockedAccount(teamId, async ({ account }) =>
      this.toSummary(account),
    );
  }

  async getUsage(teamId: string): Promise<BillingUsageResponse> {
    return this.withLockedAccount(teamId, async ({ account, client }) => {
      const entries = await this.store.listLedger(
        account.teamId,
        undefined,
        client,
      );
      const usageByFeature = new Map<string, BillingUsageItem>();

      let totalCreditsConsumed = 0;
      let totalPagesConsumed = 0;
      let totalEvents = 0;

      const cycleStartMs = Date.parse(account.cycleStartAt);
      const cycleEndMs = Date.parse(account.cycleEndAt);

      for (const entry of entries) {
        const createdAtMs = Date.parse(entry.createdAt);
        if (createdAtMs < cycleStartMs || createdAtMs >= cycleEndMs) {
          continue;
        }

        if (entry.eventType !== "consume") {
          continue;
        }

        const existing = usageByFeature.get(entry.feature) ?? {
          feature: entry.feature,
          creditsConsumed: 0,
          pagesConsumed: 0,
          events: 0,
        };

        if (entry.unitType === "credit") {
          const consumedCredits = Math.abs(entry.delta);
          existing.creditsConsumed += consumedCredits;
          totalCreditsConsumed += consumedCredits;
        }

        if (entry.unitType === "page") {
          const consumedPages = Math.abs(entry.delta);
          existing.pagesConsumed += consumedPages;
          totalPagesConsumed += consumedPages;
        }

        existing.events += 1;
        totalEvents += 1;
        usageByFeature.set(entry.feature, existing);
      }

      const items = [...usageByFeature.values()].sort((a, b) => {
        if (b.creditsConsumed !== a.creditsConsumed) {
          return b.creditsConsumed - a.creditsConsumed;
        }

        if (b.pagesConsumed !== a.pagesConsumed) {
          return b.pagesConsumed - a.pagesConsumed;
        }

        return b.events - a.events;
      });

      return {
        teamId: account.teamId,
        cycleStartAt: account.cycleStartAt,
        cycleEndAt: account.cycleEndAt,
        totals: {
          creditsConsumed: totalCreditsConsumed,
          pagesConsumed: totalPagesConsumed,
          events: totalEvents,
        },
        items,
      };
    });
  }

  async getLedger(teamId: string, limit = 50): Promise<BillingLedgerResponse> {
    return this.withLockedAccount(teamId, async ({ account, client }) => {
      const safeLimit = Number.isFinite(limit)
        ? Math.min(200, Math.max(1, Math.floor(limit)))
        : 50;

      return {
        teamId: account.teamId,
        items: await this.store.listLedger(account.teamId, safeLimit, client),
      };
    });
  }

  async getSubscription(teamId: string): Promise<BillingSubscriptionResponse> {
    return this.withLockedAccount(teamId, async ({ account, client }) => {
      const subscription = await this.store.getSubscriptionByTeam(
        account.teamId,
        client,
      );

      return this.toSubscriptionSummary(account, subscription);
    });
  }

  async createSubscriptionCheckout(
    teamId: string,
    input: CreateTeamSubscriptionCheckoutRequest,
    actor: { userId: string; email: string },
  ): Promise<CreateTeamSubscriptionCheckoutResponse> {
    this.ensureTeamBillingEnabled();

    if (input.planFamily !== TEAM_STANDARD_PLAN) {
      throw new BillingError(
        "UNSUPPORTED_TEAM_PLAN",
        400,
        "Only team_standard is available in this release",
      );
    }

    return this.withLockedAccount(teamId, async ({ account }) => {
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
    this.ensureTeamBillingEnabled();

    return this.withLockedAccount(teamId, async ({ account, client }) => {
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
    });
  }

  async cancelSubscription(
    teamId: string,
    actorUserId: string,
  ): Promise<CancelTeamSubscriptionResponse> {
    this.ensureTeamBillingEnabled();

    return this.withLockedAccount(teamId, async ({ account, client }) => {
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
    });
  }

  async syncSubscriptionSnapshot(snapshot: TeamSubscriptionSnapshot) {
    this.ensureTeamBillingEnabled();

    return this.withLockedAccount(
      snapshot.teamId,
      async ({ account, client }) => {
        await this.applySubscriptionSnapshotLocked(account, snapshot, client);
        return this.toSubscriptionSummary(
          account,
          await this.store.getSubscriptionByTeam(account.teamId, client),
        );
      },
    );
  }

  async processSubscriptionWebhookEvent(
    input: BillingWebhookProcessInput,
  ): Promise<BillingWebhookProcessResult> {
    const providerEventId =
      input.providerEventId?.trim() || this.createFallbackWebhookEventId(input);
    const payload = input.payload ?? {};
    const metadata = input.metadata ?? {};

    const existing = await this.store.getWebhookEventByProviderEventId(
      input.provider,
      providerEventId,
    );

    const webhookEvent = existing
      ? await this.store.incrementWebhookEventAttempt(existing.id, {
          eventType: input.eventType,
          teamId: input.teamId,
          externalSubscriptionId: input.externalSubscriptionId,
          payload,
          metadata,
        })
      : await this.store.insertWebhookEvent({
          provider: input.provider,
          providerEventId,
          eventType: input.eventType,
          teamId: input.teamId,
          externalSubscriptionId: input.externalSubscriptionId,
          payload,
          metadata,
        });

    if (existing?.status === "processed") {
      return {
        outcome: "duplicate",
        webhookEvent,
        reason: "already_processed",
      };
    }

    if (!this.runtimeConfig.teamBillingEnabled) {
      const ignored = await this.store.updateWebhookEventState(
        webhookEvent.id,
        {
          status: "ignored",
          teamId: input.teamId,
          externalSubscriptionId: input.externalSubscriptionId,
          processedAt: new Date().toISOString(),
          errorCode: "TEAM_BILLING_DISABLED",
          errorMessage:
            "Team billing is disabled, webhook was recorded without applying business sync",
        },
      );

      return {
        outcome: "ignored",
        webhookEvent: ignored,
        reason: "team_billing_disabled",
      };
    }

    if (!input.snapshot) {
      const ignored = await this.store.updateWebhookEventState(
        webhookEvent.id,
        {
          status: "ignored",
          teamId: input.teamId,
          externalSubscriptionId: input.externalSubscriptionId,
          processedAt: new Date().toISOString(),
          errorCode: "WEBHOOK_CONTEXT_MISSING",
          errorMessage: "Cannot map webhook payload to a supported team plan",
        },
      );

      return {
        outcome: "ignored",
        webhookEvent: ignored,
        reason: "context_missing",
      };
    }

    try {
      await this.syncSubscriptionSnapshot(input.snapshot);

      const processed = await this.store.updateWebhookEventState(
        webhookEvent.id,
        {
          status: "processed",
          teamId: input.snapshot.teamId,
          externalSubscriptionId: input.snapshot.externalSubscriptionId,
          processedAt: new Date().toISOString(),
          errorCode: null,
          errorMessage: null,
        },
      );

      return {
        outcome: "processed",
        webhookEvent: processed,
      };
    } catch (error) {
      const details = this.toWebhookError(error);
      await this.store.updateWebhookEventState(webhookEvent.id, {
        status: "failed",
        teamId: input.snapshot.teamId,
        externalSubscriptionId: input.snapshot.externalSubscriptionId,
        processedAt: new Date().toISOString(),
        errorCode: details.code,
        errorMessage: details.message,
      });
      throw error;
    }
  }

  async reconcileTeamSubscriptions(): Promise<TeamPlanReconcileResult> {
    if (
      !this.runtimeConfig.teamBillingEnabled ||
      !this.runtimeConfig.reconcileEnabled
    ) {
      return {
        checked: 0,
        realigned: 0,
        anomalies: [],
      };
    }

    const states = await this.store.listAccountSubscriptionStates();
    const anomalies: TeamPlanReconcileAnomaly[] = [];
    let realigned = 0;

    for (const state of states) {
      const expectedFromState = this.resolvePlanFromSubscription(
        state.subscriptionStatus ?? "inactive",
      );

      if (state.accountPlanFamily === expectedFromState) {
        continue;
      }

      await this.withLockedAccount(
        state.teamId,
        async ({ account, client }) => {
          const latestSubscription = await this.store.getSubscriptionByTeam(
            account.teamId,
            client,
          );
          const expectedPlan = this.resolvePlanFromSubscription(
            latestSubscription?.status ?? "inactive",
          );

          if (account.planFamily === expectedPlan) {
            return;
          }

          const previousPlanFamily = account.planFamily;
          await this.applyPlanFamilyLocked(account, expectedPlan, client, {
            source: "reconcile",
            reason: "plan_mismatch",
            previousPlanFamily,
            expectedPlanFamily: expectedPlan,
            subscriptionStatus: latestSubscription?.status ?? "inactive",
          });

          realigned += 1;
          anomalies.push({
            teamId: account.teamId,
            previousPlanFamily,
            expectedPlanFamily: expectedPlan,
            subscriptionStatus: latestSubscription?.status ?? "inactive",
            externalSubscriptionId:
              latestSubscription?.externalSubscriptionId ?? null,
          });
        },
      );
    }

    return {
      checked: states.length,
      realigned,
      anomalies,
    };
  }

  async updateSpendLimits(
    teamId: string,
    input: UpdateSpendLimitsRequest,
  ): Promise<UpdateSpendLimitsResponse> {
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

  async createTopupCheckout(
    teamId: string,
    input: CreateTopupCheckoutRequest,
    actorUserId?: string,
  ): Promise<CreateTopupCheckoutResponse> {
    return this.withLockedAccount(teamId, async ({ account, client }) => {
      const creditsToAdd = Math.floor(input.credits);

      if (creditsToAdd <= 0) {
        throw new BillingError(
          "INVALID_TOPUP_CREDITS",
          400,
          "Topup credits must be greater than zero",
        );
      }

      account.addOnCreditsBalance += creditsToAdd;
      account.updatedAt = new Date().toISOString();
      await this.store.updateAccount(account, client);

      await this.appendLedger(client, account, {
        eventType: "grant",
        unitType: "credit",
        delta: creditsToAdd,
        balanceAfter: this.getTotalCreditsBalance(account),
        feature: "topup",
        actorUserId,
        referenceId: `topup:${randomUUID()}`,
        metadata: {
          provider: this.runtimeConfig.provider,
        },
      });

      return {
        teamId: account.teamId,
        provider: this.runtimeConfig.provider,
        status: "completed",
        credits: creditsToAdd,
        amountUsd: toUsdFromCredits(
          creditsToAdd,
          this.runtimeConfig.creditUnitUsd,
        ),
      };
    });
  }

  async meterConsume(
    teamId: string,
    input: MeterConsumeRequest,
    actorUserId: string,
  ): Promise<MeterConsumeResponse> {
    return this.withLockedAccount(teamId, async ({ account, client }) => {
      if (
        !this.runtimeConfig.creditsEnabled ||
        this.runtimeConfig.mode === "disabled"
      ) {
        return {
          teamId: account.teamId,
          consumedCredits: 0,
          availableCredits: this.getAvailableCredits(account),
          consumedThisCycle: account.creditsConsumedThisCycle,
          idempotencyReplayed: false,
        };
      }

      const idempotencyKey = input.idempotencyKey?.trim();
      if (idempotencyKey) {
        const existing = await this.store.getLedgerByIdempotency(
          account.teamId,
          idempotencyKey,
          client,
        );

        if (
          existing &&
          existing.unitType === "credit" &&
          existing.eventType === "consume"
        ) {
          return {
            teamId: account.teamId,
            consumedCredits: Math.abs(existing.delta),
            availableCredits: this.getAvailableCredits(account),
            consumedThisCycle: account.creditsConsumedThisCycle,
            idempotencyReplayed: true,
          };
        }
      }

      const creditsToConsume =
        input.credits ??
        computeCreditsFromCost({
          providerCostUsd: input.providerCostUsd ?? 0,
          platformCostUsd: input.platformCostUsd ?? 0,
          markupRate: input.markupRate ?? this.runtimeConfig.defaultMarkupRate,
          creditUnitUsd: this.runtimeConfig.creditUnitUsd,
        });

      if (creditsToConsume <= 0) {
        throw new BillingError(
          "INVALID_CREDITS_VALUE",
          400,
          "Credits to consume must be greater than zero",
        );
      }

      await this.ensureCreditsCapacity({
        account,
        creditsToConsume,
        feature: input.feature,
        actorUserId,
        client,
      });

      this.spendCredits(account, creditsToConsume);
      account.creditsConsumedThisCycle += creditsToConsume;
      account.updatedAt = new Date().toISOString();
      await this.store.updateAccount(account, client);

      await this.appendLedger(client, account, {
        eventType: "consume",
        unitType: "credit",
        delta: -creditsToConsume,
        balanceAfter: this.getTotalCreditsBalance(account),
        feature: input.feature ?? DEFAULT_CONSUME_FEATURE,
        actorUserId,
        workspaceId: input.workspaceId,
        referenceId: input.referenceId,
        idempotencyKey,
        metadata: {
          creditUnitUsd: this.runtimeConfig.creditUnitUsd,
        },
      });

      return {
        teamId: account.teamId,
        consumedCredits: creditsToConsume,
        availableCredits: this.getAvailableCredits(account),
        consumedThisCycle: account.creditsConsumedThisCycle,
        idempotencyReplayed: false,
      };
    });
  }

  async meterIngestion(
    teamId: string,
    input: MeterIngestionRequest,
    actorUserId: string,
  ): Promise<MeterIngestionResponse> {
    return this.withLockedAccount(teamId, async ({ account, client }) => {
      if (
        !this.runtimeConfig.pagesEnabled ||
        this.runtimeConfig.mode === "disabled"
      ) {
        return {
          teamId: account.teamId,
          pagesConsumed: 0,
          pagesUsed: account.pagesUsed,
          pagesRemaining: Math.max(account.pagesLimit - account.pagesUsed, 0),
          idempotencyReplayed: false,
        };
      }

      const idempotencyKey = input.idempotencyKey?.trim();
      if (idempotencyKey) {
        const existing = await this.store.getLedgerByIdempotency(
          account.teamId,
          idempotencyKey,
          client,
        );

        if (
          existing &&
          existing.unitType === "page" &&
          existing.eventType === "consume"
        ) {
          return {
            teamId: account.teamId,
            pagesConsumed: Math.abs(existing.delta),
            pagesUsed: account.pagesUsed,
            pagesRemaining: Math.max(account.pagesLimit - account.pagesUsed, 0),
            idempotencyReplayed: true,
          };
        }
      }

      const pagesToConsume =
        input.pages ??
        resolveIngestionPages({
          parsedTokens: input.parsedTokens,
        });

      if (pagesToConsume <= 0) {
        throw new BillingError(
          "INVALID_PAGES_VALUE",
          400,
          "Pages to consume must be greater than zero",
        );
      }

      await this.ensurePagesCapacity({
        account,
        pagesToConsume,
        feature: input.feature,
        actorUserId,
        client,
      });

      account.pagesUsed += pagesToConsume;
      account.updatedAt = new Date().toISOString();
      await this.store.updateAccount(account, client);

      await this.appendLedger(client, account, {
        eventType: "consume",
        unitType: "page",
        delta: pagesToConsume,
        balanceAfter: account.pagesUsed,
        feature: input.feature ?? DEFAULT_INGESTION_FEATURE,
        actorUserId,
        workspaceId: input.workspaceId,
        referenceId: input.referenceId,
        idempotencyKey,
        metadata: {
          pageLimit: account.pagesLimit,
        },
      });

      return {
        teamId: account.teamId,
        pagesConsumed: pagesToConsume,
        pagesUsed: account.pagesUsed,
        pagesRemaining: Math.max(account.pagesLimit - account.pagesUsed, 0),
        idempotencyReplayed: false,
      };
    });
  }

  private ensureTeamBillingEnabled() {
    if (!this.runtimeConfig.teamBillingEnabled) {
      throw new BillingError(
        "TEAM_BILLING_DISABLED",
        409,
        "Team billing is disabled",
      );
    }
  }

  private toWebhookError(error: unknown): { code: string; message: string } {
    if (error instanceof BillingError) {
      return {
        code: error.code,
        message: error.message,
      };
    }

    if (error instanceof Error) {
      return {
        code: "INTERNAL_WEBHOOK_ERROR",
        message: error.message,
      };
    }

    return {
      code: "INTERNAL_WEBHOOK_ERROR",
      message: String(error),
    };
  }

  private toSubscriptionSummary(
    account: BillingAccountState,
    subscription: BillingSubscriptionState | null,
  ): BillingSubscriptionResponse {
    return {
      teamId: account.teamId,
      provider: subscription?.provider ?? this.runtimeConfig.provider,
      planFamily: subscription?.planFamily ?? account.planFamily,
      status: subscription?.status ?? "inactive",
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      externalCustomerId: subscription?.externalCustomerId ?? null,
      externalSubscriptionId: subscription?.externalSubscriptionId ?? null,
      lastEventAt: subscription?.lastEventAt ?? null,
    };
  }

  private async applySubscriptionSnapshotLocked(
    account: BillingAccountState,
    snapshot: TeamSubscriptionSnapshot,
    client: PoolClient,
  ) {
    await this.store.upsertSubscription(snapshot, client);

    if (snapshot.seatCount !== account.seatCount) {
      account.seatCount = snapshot.seatCount;
    }

    const targetPlan = this.resolvePlanFromSubscription(snapshot.status);
    if (account.planFamily !== targetPlan) {
      await this.applyPlanFamilyLocked(account, targetPlan, client, {
        source: "subscription",
        provider: snapshot.provider,
        status: snapshot.status,
      });
    }
  }

  private resolvePlanFromSubscription(status: BillingSubscriptionStatus) {
    if (ACTIVE_SUBSCRIPTION_STATUSES.has(status)) {
      return TEAM_STANDARD_PLAN;
    }

    return this.runtimeConfig.defaultPlanFamily;
  }

  private async applyPlanFamilyLocked(
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

      await this.appendLedger(client, account, {
        eventType: "grant",
        unitType: "credit",
        delta: grantDelta,
        balanceAfter: this.getTotalCreditsBalance(account),
        feature: "plan_upgrade_grant",
        metadata: {
          ...metadata,
          fromPlanFamily: previousPlanFamily,
          toPlanFamily: nextPlanFamily,
          reason: "plan_upgrade",
        },
      });
    }

    if (account.pagesLimit !== previousPagesLimit) {
      await this.appendLedger(client, account, {
        eventType: "adjust",
        unitType: "page",
        delta: 0,
        balanceAfter: account.pagesUsed,
        feature: "plan_change",
        metadata: {
          ...metadata,
          fromPlanFamily: previousPlanFamily,
          toPlanFamily: nextPlanFamily,
          previousPagesLimit,
          nextPagesLimit: account.pagesLimit,
        },
      });
    }

    account.updatedAt = new Date().toISOString();
    await this.store.updateAccount(account, client);
  }

  private normalizeTeamId(teamId: string) {
    const value = teamId.trim();
    if (!value) {
      throw new BillingError("INVALID_TEAM_ID", 400, "teamId is required");
    }

    return value;
  }

  private async withLockedAccount<T>(
    teamId: string,
    callback: (input: {
      account: BillingAccountState;
      client: PoolClient;
    }) => Promise<T>,
  ) {
    const normalizedTeamId = this.normalizeTeamId(teamId);

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

    if (this.runtimeConfig.creditsEnabled && quota.monthlyCreditsGrant > 0) {
      await this.appendLedger(client, account, {
        eventType: "grant",
        unitType: "credit",
        delta: quota.monthlyCreditsGrant,
        balanceAfter: this.getTotalCreditsBalance(account),
        feature: "cycle_grant",
        idempotencyKey: `cycle-grant:${account.cycleStartAt}`,
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
        await this.appendLedger(client, account, {
          eventType: "expire",
          unitType: "credit",
          delta: -previousMonthlyBalance,
          balanceAfter: this.getTotalCreditsBalance(account),
          feature: "cycle_expire",
          idempotencyKey: `cycle-expire:${account.cycleStartAt}`,
        });
      }

      account.monthlyCreditsBalance = quota.monthlyCreditsGrant;
      if (quota.monthlyCreditsGrant > 0) {
        await this.appendLedger(client, account, {
          eventType: "grant",
          unitType: "credit",
          delta: quota.monthlyCreditsGrant,
          balanceAfter: this.getTotalCreditsBalance(account),
          feature: "cycle_grant",
          idempotencyKey: `cycle-grant:${account.cycleStartAt}`,
        });
      }
    }

    if (previousPagesUsed > 0) {
      await this.appendLedger(client, account, {
        eventType: "adjust",
        unitType: "page",
        delta: -previousPagesUsed,
        balanceAfter: 0,
        feature: "cycle_reset",
        idempotencyKey: `cycle-pages-reset:${account.cycleStartAt}`,
      });
    }

    account.updatedAt = now.toISOString();
    await this.store.updateAccount(account, client);
    return account;
  }

  private async ensureCreditsCapacity(input: {
    account: BillingAccountState;
    creditsToConsume: number;
    feature?: string;
    actorUserId?: string;
    client: PoolClient;
  }) {
    const { account, creditsToConsume, feature, actorUserId, client } = input;
    const available = this.getAvailableCredits(account);

    if (
      this.runtimeConfig.mode !== "enforced" &&
      available < creditsToConsume
    ) {
      const missing = creditsToConsume - available;
      account.addOnCreditsBalance += missing;

      await this.appendLedger(client, account, {
        eventType: "grant",
        unitType: "credit",
        delta: missing,
        balanceAfter: this.getTotalCreditsBalance(account),
        feature: "shadow_auto_grant",
        actorUserId,
        metadata: {
          reason: "shadow_overage",
          originalFeature: feature ?? DEFAULT_CONSUME_FEATURE,
        },
      });
    }

    if (
      this.runtimeConfig.mode === "enforced" &&
      available < creditsToConsume
    ) {
      throw new BillingError("CREDITS_EXHAUSTED", 402, "Not enough credits", {
        teamId: account.teamId,
        requested: creditsToConsume,
        available,
      });
    }

    if (
      this.runtimeConfig.mode === "enforced" &&
      this.runtimeConfig.enforceLimits &&
      account.spendHardCapUsd !== null
    ) {
      const usedUsd = toUsdFromCredits(
        account.creditsConsumedThisCycle,
        this.runtimeConfig.creditUnitUsd,
      );
      const incomingUsd = toUsdFromCredits(
        creditsToConsume,
        this.runtimeConfig.creditUnitUsd,
      );

      if (usedUsd + incomingUsd > account.spendHardCapUsd) {
        throw new BillingError(
          "BILLING_LIMIT_EXCEEDED",
          402,
          "Hard spend cap exceeded",
          {
            hardCapUsd: account.spendHardCapUsd,
            usedUsd,
            incomingUsd,
          },
        );
      }
    }
  }

  private async ensurePagesCapacity(input: {
    account: BillingAccountState;
    pagesToConsume: number;
    feature?: string;
    actorUserId?: string;
    client: PoolClient;
  }) {
    const { account, pagesToConsume, feature, actorUserId, client } = input;
    const projected = account.pagesUsed + pagesToConsume;

    if (projected <= account.pagesLimit) {
      return;
    }

    if (
      this.runtimeConfig.mode === "enforced" &&
      this.runtimeConfig.enforceLimits
    ) {
      throw new BillingError(
        "PAGES_LIMIT_EXCEEDED",
        402,
        "Ingestion pages limit exceeded",
        {
          teamId: account.teamId,
          limit: account.pagesLimit,
          used: account.pagesUsed,
          requested: pagesToConsume,
        },
      );
    }

    const previousLimit = account.pagesLimit;
    account.pagesLimit = projected;

    await this.appendLedger(client, account, {
      eventType: "adjust",
      unitType: "page",
      delta: 0,
      balanceAfter: account.pagesUsed,
      feature: "shadow_limit_expand",
      actorUserId,
      metadata: {
        previousLimit,
        expandedLimit: projected,
        originalFeature: feature ?? DEFAULT_INGESTION_FEATURE,
      },
    });
  }

  private spendCredits(account: BillingAccountState, creditsToConsume: number) {
    let remaining = creditsToConsume;

    if (account.monthlyCreditsBalance > 0) {
      const fromMonthly = Math.min(account.monthlyCreditsBalance, remaining);
      account.monthlyCreditsBalance -= fromMonthly;
      remaining -= fromMonthly;
    }

    if (remaining > 0 && account.addOnCreditsBalance > 0) {
      const fromAddOn = Math.min(account.addOnCreditsBalance, remaining);
      account.addOnCreditsBalance -= fromAddOn;
      remaining -= fromAddOn;
    }

    if (remaining > 0) {
      throw new BillingError(
        "INSUFFICIENT_CREDITS_INTERNAL",
        500,
        "Unable to allocate credit buckets for consumption",
      );
    }
  }

  private toSummary(account: BillingAccountState): BillingSummaryResponse {
    const pagesRemaining = Math.max(account.pagesLimit - account.pagesUsed, 0);

    return {
      teamId: account.teamId,
      planFamily: account.planFamily,
      billingMode: this.runtimeConfig.mode,
      cycleStartAt: account.cycleStartAt,
      cycleEndAt: account.cycleEndAt,
      pages: {
        limit: account.pagesLimit,
        used: account.pagesUsed,
        remaining: pagesRemaining,
      },
      credits: {
        monthlyGrant: account.monthlyCreditsGrant,
        monthlyBalance: account.monthlyCreditsBalance,
        addOnBalance: account.addOnCreditsBalance,
        reserved: account.creditsReserved,
        consumedThisCycle: account.creditsConsumedThisCycle,
        available: this.getAvailableCredits(account),
      },
      spendLimits: {
        softCapUsd: account.spendSoftCapUsd,
        hardCapUsd: account.spendHardCapUsd,
      },
    };
  }

  private getTotalCreditsBalance(account: BillingAccountState) {
    return account.monthlyCreditsBalance + account.addOnCreditsBalance;
  }

  private getAvailableCredits(account: BillingAccountState) {
    const available =
      this.getTotalCreditsBalance(account) - account.creditsReserved;
    return Math.max(available, 0);
  }

  private createFallbackWebhookEventId(input: BillingWebhookProcessInput) {
    const seed = {
      provider: input.provider,
      eventType: input.eventType,
      teamId: input.teamId ?? null,
      externalSubscriptionId: input.externalSubscriptionId ?? null,
      snapshotStatus: input.snapshot?.status ?? null,
      snapshotCurrentPeriodStart: input.snapshot?.currentPeriodStart ?? null,
      snapshotCurrentPeriodEnd: input.snapshot?.currentPeriodEnd ?? null,
      snapshotCancelAtPeriodEnd: input.snapshot?.cancelAtPeriodEnd ?? null,
      payload: input.payload,
    };

    const digest = createHash("sha256")
      .update(this.stableSerialize(seed))
      .digest("hex")
      .slice(0, 32);

    return `fallback:${digest}`;
  }

  private stableSerialize(value: unknown): string {
    if (value === null || value === undefined) {
      return "null";
    }

    if (typeof value === "string") {
      return JSON.stringify(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableSerialize(item)).join(",")}]`;
    }

    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const entries = keys.map(
        (key) => `${JSON.stringify(key)}:${this.stableSerialize(record[key])}`,
      );
      return `{${entries.join(",")}}`;
    }

    return JSON.stringify(String(value));
  }

  private async appendLedger(
    client: PoolClient,
    account: BillingAccountState,
    input: LedgerWriteInput,
  ) {
    const entry: BillingLedgerEntry = {
      id: randomUUID(),
      teamId: account.teamId,
      workspaceId: input.workspaceId ?? null,
      actorUserId: input.actorUserId ?? null,
      feature: input.feature,
      eventType: input.eventType,
      unitType: input.unitType,
      delta: input.delta,
      balanceAfter: input.balanceAfter,
      referenceId: input.referenceId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };

    await this.store.appendLedger(entry, client);
    return entry;
  }
}
