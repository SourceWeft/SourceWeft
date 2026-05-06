import type { PoolClient } from "pg";
import {
  computeCreditsFromCost,
  resolveIngestionPages,
  toUsdFromCredits,
} from "@sourceweft/credits-core";
import type {
  BillingLedgerResponse,
  BillingSummaryResponse,
  BillingUsageItem,
  BillingUsageResponse,
  CreateTopupCheckoutRequest,
  CreateTopupCheckoutResponse,
  MeterConsumeRequest,
  MeterConsumeResponse,
  MeterIngestionRequest,
  MeterIngestionResponse,
} from "@sourceweft/contracts";
import { BillingAccountService } from "./account-service";
import { BillingError } from "./errors";
import { appendBillingLedger } from "./ledger";
import type { BillingStore } from "./store-port";
import type { BillingAccountState, BillingRuntimeConfig } from "./types";
import {
  DEFAULT_CONSUME_FEATURE,
  DEFAULT_INGESTION_FEATURE,
  getAvailableCredits,
  getPagesRemaining,
  getTotalCreditsBalance,
  spendCredits,
  toSummary,
} from "./service-helpers";

export class BillingUsageService {
  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    private readonly accountService: BillingAccountService,
  ) {}

  async ensureBillingAccount(teamId: string) {
    return this.accountService.withLockedAccount(
      teamId,
      async ({ account }) => account,
    );
  }

  async getSummary(teamId: string): Promise<BillingSummaryResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        const seatsUsed = await this.store.countTeamMembers(
          account.teamId,
          client,
        );

        return toSummary({
          account,
          billingMode: this.runtimeConfig.mode,
          seatsUsed,
        });
      },
    );
  }

  async getUsage(teamId: string): Promise<BillingUsageResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
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
      },
    );
  }

  async getLedger(teamId: string, limit = 50): Promise<BillingLedgerResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        const safeLimit = Number.isFinite(limit)
          ? Math.min(200, Math.max(1, Math.floor(limit)))
          : 50;

        return {
          teamId: account.teamId,
          items: await this.store.listLedger(account.teamId, safeLimit, client),
        };
      },
    );
  }

  async createTopupCheckout(
    teamId: string,
    input: CreateTopupCheckoutRequest,
    _actorUserId?: string,
  ): Promise<CreateTopupCheckoutResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      async ({ account }) => {
        const creditsToAdd = Math.floor(input.credits);

        if (creditsToAdd <= 0) {
          throw new BillingError(
            "INVALID_TOPUP_CREDITS",
            400,
            "Topup credits must be greater than zero",
          );
        }

        throw new BillingError(
          "TOPUP_CHECKOUT_NOT_CONFIGURED",
          501,
          "Top-up checkout is not available until payment provider support is configured",
          {
            teamId: account.teamId,
            provider: this.runtimeConfig.provider,
            credits: creditsToAdd,
            amountUsd: toUsdFromCredits(
              creditsToAdd,
              this.runtimeConfig.creditUnitUsd,
            ),
          },
        );
      },
    );
  }

  async meterConsume(
    teamId: string,
    input: MeterConsumeRequest,
    actorUserId: string,
  ): Promise<MeterConsumeResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        if (
          !this.runtimeConfig.creditsEnabled ||
          this.runtimeConfig.mode === "disabled"
        ) {
          return {
            teamId: account.teamId,
            consumedCredits: 0,
            availableCredits: getAvailableCredits(account),
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
              availableCredits: getAvailableCredits(account),
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

        spendCredits(account, creditsToConsume);
        account.creditsConsumedThisCycle += creditsToConsume;
        account.updatedAt = new Date().toISOString();
        await this.store.updateAccount(account, client);

        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "consume",
            unitType: "credit",
            delta: -creditsToConsume,
            balanceAfter: getTotalCreditsBalance(account),
            feature: input.feature ?? DEFAULT_CONSUME_FEATURE,
            actorUserId,
            workspaceId: input.workspaceId,
            referenceId: input.referenceId,
            idempotencyKey,
            metadata: {
              creditUnitUsd: this.runtimeConfig.creditUnitUsd,
            },
          },
        });

        return {
          teamId: account.teamId,
          consumedCredits: creditsToConsume,
          availableCredits: getAvailableCredits(account),
          consumedThisCycle: account.creditsConsumedThisCycle,
          idempotencyReplayed: false,
        };
      },
    );
  }

  async meterIngestion(
    teamId: string,
    input: MeterIngestionRequest,
    actorUserId: string,
  ): Promise<MeterIngestionResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      async ({ account, client }) => {
        if (
          !this.runtimeConfig.pagesEnabled ||
          this.runtimeConfig.mode === "disabled"
        ) {
          return {
            teamId: account.teamId,
            pagesConsumed: 0,
            pagesUsed: account.pagesUsed,
            pagesRemaining: getPagesRemaining(account),
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
              pagesRemaining: getPagesRemaining(account),
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

        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: "consume",
            unitType: "page",
            delta: -pagesToConsume,
            balanceAfter: getPagesRemaining(account),
            feature: input.feature ?? DEFAULT_INGESTION_FEATURE,
            actorUserId,
            workspaceId: input.workspaceId,
            referenceId: input.referenceId,
            idempotencyKey,
            metadata: {
              pageLimit: account.pagesLimit,
              pagesUsed: account.pagesUsed,
            },
          },
        });

        return {
          teamId: account.teamId,
          pagesConsumed: pagesToConsume,
          pagesUsed: account.pagesUsed,
          pagesRemaining: getPagesRemaining(account),
          idempotencyReplayed: false,
        };
      },
    );
  }

  private async ensureCreditsCapacity(input: {
    account: BillingAccountState;
    creditsToConsume: number;
    feature?: string;
    actorUserId?: string;
    client: PoolClient;
  }) {
    const { account, creditsToConsume, feature, actorUserId, client } = input;
    const available = getAvailableCredits(account);

    if (
      this.runtimeConfig.mode !== "enforced" &&
      available < creditsToConsume
    ) {
      const missing = creditsToConsume - available;
      account.addOnCreditsBalance += missing;

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "grant",
          unitType: "credit",
          delta: missing,
          balanceAfter: getTotalCreditsBalance(account),
          feature: "shadow_auto_grant",
          actorUserId,
          metadata: {
            reason: "shadow_overage",
            originalFeature: feature ?? DEFAULT_CONSUME_FEATURE,
          },
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
    const limitDelta = account.pagesLimit - previousLimit;

    await appendBillingLedger({
      store: this.store,
      client,
      account,
      entry: {
        eventType: "adjust",
        unitType: "page",
        delta: limitDelta,
        balanceAfter: getPagesRemaining(account),
        feature: "shadow_limit_expand",
        actorUserId,
        metadata: {
          previousLimit,
          expandedLimit: projected,
          pagesUsed: account.pagesUsed,
          originalFeature: feature ?? DEFAULT_INGESTION_FEATURE,
        },
      },
    });
  }
}
