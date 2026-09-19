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
import { BillingOrderService } from "./order-service";
import { BillingError } from "./errors";
import {
  appendBillingLedger,
  createOperationId,
  formatSignedLedgerDelta,
  scopeMemberLedgerKey,
} from "./ledger";
import {
  consumePages,
  decidePageAdmission,
  getAvailablePages,
  getTotalPagesBalance,
  grantAddOnPages,
} from "./page-ledger";
import type { BillingStore } from "./store-port";
import type { BillingAccountState, BillingRuntimeConfig } from "./types";
import {
  DEFAULT_CONSUME_FEATURE,
  DEFAULT_INGESTION_FEATURE,
  getAvailableCredits,
  getTotalCreditsBalance,
  normalizeTeamId,
  refundConsumedCredits,
  spendCredits,
  toSummary,
} from "./service-helpers";

/**
 * Settlement entry: the single funnel every metered consumption goes through.
 *
 * `meterConsume` (credits) and `meterIngestion` (pages) are the only places
 * usage turns into ledger rows, and both keep the same shape: lock the acting
 * member's own account row (谁问谁付), replay on idempotency key, run the
 * capacity precheck, then settle — balance transition plus one ledger entry in
 * the same transaction, only after the work succeeded (settle-on-success).
 * Read models (`getSummary`/`getUsage`/`getLedger`) live here too because they
 * present the same funnel's output.
 *
 * Dependencies point downward: locking and cycle lifecycle come from
 * `account-service`; balance transitions from the ledger primitives
 * (`page-ledger` for pages, `service-helpers` for credits); row writes from
 * `ledger`/`store-port`. The one lateral hop is `createTopupCheckout`
 * delegating to `order-service`, since a top-up starts as an order, not usage.
 */
export class BillingUsageService {
  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    private readonly accountService: BillingAccountService,
    private readonly orderService?: BillingOrderService,
  ) {}

  async ensureBillingAccount(teamId: string, userId: string) {
    return this.accountService.withLockedAccount(
      teamId,
      userId,
      async ({ account }) => account,
    );
  }

  async getSummary(
    teamId: string,
    userId: string,
  ): Promise<BillingSummaryResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      userId,
      async ({ account, client }) => {
        const activeMembers = await this.store.countTeamMembers(
          account.teamId,
          client,
        );
        const pendingInvitations = await this.store.countPendingTeamInvitations(
          account.teamId,
          client,
        );
        const seatsUsed = activeMembers + pendingInvitations;

        return toSummary({
          account,
          billingMode: this.runtimeConfig.mode,
          seatsUsed,
          activeMembers,
          pendingInvitations,
        });
      },
    );
  }

  async getUsage(
    teamId: string,
    userId: string,
  ): Promise<BillingUsageResponse> {
    return this.accountService.withLockedAccount(
      teamId,
      userId,
      async ({ account, client }) => {
        const entries = await this.store.listLedger(
          account.teamId,
          undefined,
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

          const isCreditUsage =
            entry.unitType === "credit" &&
            (entry.eventType === "consume" || entry.eventType === "refund");
          const isPageUsage =
            entry.unitType === "page" && entry.eventType === "consume";
          if (!isCreditUsage && !isPageUsage) {
            continue;
          }

          const existing = usageByFeature.get(entry.feature) ?? {
            feature: entry.feature,
            creditsConsumed: 0,
            pagesConsumed: 0,
            events: 0,
          };

          if (isCreditUsage) {
            const creditsDelta = -entry.delta;
            existing.creditsConsumed += creditsDelta;
            totalCreditsConsumed += creditsDelta;
          }

          if (isPageUsage) {
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

  async getLedger(
    teamId: string,
    limit = 50,
    options?: {
      activityOnly?: boolean;
      actorUserId?: string;
      cursor?: { createdAt: Date; id: string } | null;
    },
  ): Promise<BillingLedgerResponse> {
    // The ledger is the team's activity feed. Callers scope it: managers read it
    // team-wide, a plain member is restricted to their own lines via actorUserId.
    // It's a plain team-scoped read — no per-member account lock required.
    const normalizedTeamId = normalizeTeamId(teamId);
    const safeLimit = Number.isFinite(limit)
      ? Math.min(200, Math.max(1, Math.floor(limit)))
      : 50;

    const rows = await this.store.listLedger(
      normalizedTeamId,
      safeLimit + 1,
      options,
    );
    const items = rows.slice(0, safeLimit);
    const nextRow = rows[safeLimit] ?? null;

    return {
      teamId: normalizedTeamId,
      items,
      nextCursor: nextRow
        ? Buffer.from(
            JSON.stringify({
              createdAt: nextRow.createdAt,
              id: nextRow.id,
            }),
            "utf8",
          ).toString("base64url")
        : null,
    };
  }

  async createTopupCheckout(
    teamId: string,
    input: CreateTopupCheckoutRequest,
    actorUserId?: string,
    actorEmail?: string,
  ): Promise<CreateTopupCheckoutResponse> {
    if (this.orderService && actorUserId && actorEmail) {
      return this.orderService.createTopupCheckout({
        teamId,
        request: input,
        actor: {
          userId: actorUserId,
          email: actorEmail,
        },
      });
    }

    // No configured order service: this path only validates and reports that
    // checkout is unavailable, so it needs no per-member account lock.
    const creditsToAdd = Math.floor(input.quantity);

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
        teamId: normalizeTeamId(teamId),
        provider: this.runtimeConfig.provider,
        credits: creditsToAdd,
        amountUsd: toUsdFromCredits(
          creditsToAdd,
          this.runtimeConfig.creditUnitUsd,
        ),
      },
    );
  }

  async meterConsume(
    teamId: string,
    input: MeterConsumeRequest,
    actorUserId: string,
  ): Promise<MeterConsumeResponse> {
    // 谁问谁付: consumption deducts from the acting member's own allocation row.
    return this.accountService.withLockedAccount(
      teamId,
      actorUserId,
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
            scopeMemberLedgerKey(account.userId, idempotencyKey),
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

        // The markup rate actually applied at this moment — captured into the
        // ledger below so a later async reconciliation (which may run minutes
        // or hours from now, after `runtimeConfig.defaultMarkupRate` has
        // possibly changed) recomputes against the rate this charge was made
        // under, not whatever the platform default happens to be by then.
        const markupRateApplied =
          input.markupRate ?? this.runtimeConfig.defaultMarkupRate;
        const creditsToConsume =
          input.credits ??
          computeCreditsFromCost({
            providerCostUsd: input.providerCostUsd ?? 0,
            platformCostUsd: input.platformCostUsd ?? 0,
            markupRate: markupRateApplied,
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

        const creditAllocation = spendCredits(account, creditsToConsume);
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
            operationId:
              idempotencyKey ??
              (input.referenceId
                ? createOperationId("usage", account.teamId, input.referenceId)
                : undefined),
            operationType: "usage",
            activityVisible: true,
            activityTitle: "Chat credits used",
            activitySummary: formatSignedLedgerDelta(
              "credit",
              -creditsToConsume,
            ),
            metadata: {
              creditUnitUsd: this.runtimeConfig.creditUnitUsd,
              creditAllocation,
              ...(input.modelKind ? { modelKind: input.modelKind } : {}),
              ...(input.operation ? { operation: input.operation } : {}),
              ...(input.providerCostUsd !== undefined
                ? { providerCostUsd: input.providerCostUsd }
                : {}),
              ...(input.platformCostUsd !== undefined
                ? { platformCostUsd: input.platformCostUsd }
                : {}),
              markupRate: markupRateApplied,
              ...(input.metadata ?? {}),
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

  async reconcileModelProviderCost(input: {
    teamId: string;
    actorUserId: string;
    workspaceId?: string;
    feature: string;
    originalIdempotencyKey: string;
    reconciliationIdempotencyKey: string;
    generationId: string;
    provider: string;
    providerRequestId: string;
    settledProviderCostUsd: number;
  }) {
    return this.accountService.withLockedAccount(
      input.teamId,
      input.actorUserId,
      async ({ account, client }) => {
        const reconciliationKey = scopeMemberLedgerKey(
          account.userId,
          input.reconciliationIdempotencyKey,
        );
        const existing = await this.store.getLedgerByIdempotency(
          account.teamId,
          reconciliationKey,
          client,
        );
        if (existing) {
          return {
            adjustedCredits: existing.delta,
            idempotencyReplayed: true,
          };
        }

        const original = await this.store.getLedgerByIdempotency(
          account.teamId,
          scopeMemberLedgerKey(account.userId, input.originalIdempotencyKey),
          client,
        );
        if (
          !original ||
          original.unitType !== "credit" ||
          original.eventType !== "consume"
        ) {
          throw new BillingError(
            "MODEL_COST_LEDGER_NOT_FOUND",
            409,
            "Original model usage ledger entry was not found",
          );
        }
        const metadata = original.metadata ?? {};
        const creditUnitUsd =
          typeof metadata.creditUnitUsd === "number"
            ? metadata.creditUnitUsd
            : this.runtimeConfig.creditUnitUsd;
        // Prefer the rate captured on the original charge (meterConsume now
        // always writes it). Falling back to the current runtime default only
        // covers ledger rows written before this field existed — for those,
        // reconciliation can still conflate a markup-rate change with a real
        // cost change, which is a known, accepted gap for pre-existing rows.
        const markupRate =
          typeof metadata.markupRate === "number"
            ? metadata.markupRate
            : this.runtimeConfig.defaultMarkupRate;
        const platformCostUsd =
          typeof metadata.platformCostUsd === "number"
            ? metadata.platformCostUsd
            : 0;
        const desiredCredits = computeCreditsFromCost({
          providerCostUsd: input.settledProviderCostUsd,
          platformCostUsd,
          markupRate,
          creditUnitUsd,
        });
        const originalCredits = Math.abs(original.delta);
        const creditsDifference = desiredCredits - originalCredits;
        if (creditsDifference === 0) {
          return { adjustedCredits: 0, idempotencyReplayed: false };
        }

        let allocation: Record<string, unknown> | undefined;
        if (creditsDifference > 0) {
          await this.ensureCreditsCapacity({
            account,
            creditsToConsume: creditsDifference,
            feature: input.feature,
            actorUserId: input.actorUserId,
            client,
          });
          allocation = spendCredits(account, creditsDifference);
          account.creditsConsumedThisCycle += creditsDifference;
        } else {
          const originalAllocation =
            metadata.creditAllocation &&
            typeof metadata.creditAllocation === "object" &&
            !Array.isArray(metadata.creditAllocation)
              ? (metadata.creditAllocation as {
                  monthly?: number;
                  addOn?: number;
                })
              : undefined;
          allocation = refundConsumedCredits(
            account,
            Math.abs(creditsDifference),
            originalAllocation,
          );
          account.creditsConsumedThisCycle = Math.max(
            0,
            account.creditsConsumedThisCycle + creditsDifference,
          );
        }
        account.updatedAt = new Date().toISOString();
        await this.store.updateAccount(account, client);

        await appendBillingLedger({
          store: this.store,
          client,
          account,
          entry: {
            eventType: creditsDifference > 0 ? "consume" : "refund",
            unitType: "credit",
            delta: -creditsDifference,
            balanceAfter: getTotalCreditsBalance(account),
            feature: input.feature,
            actorUserId: input.actorUserId,
            workspaceId: input.workspaceId,
            referenceId: input.generationId,
            idempotencyKey: input.reconciliationIdempotencyKey,
            operationId: input.reconciliationIdempotencyKey,
            operationType: "usage",
            activityVisible: false,
            metadata: {
              generationId: input.generationId,
              provider: input.provider,
              providerRequestId: input.providerRequestId,
              originalCredits,
              desiredCredits,
              creditsDifference,
              settledProviderCostUsd: input.settledProviderCostUsd,
              creditUnitUsd,
              markupRate,
              platformCostUsd,
              creditAllocation: allocation,
            },
          },
        });

        return {
          adjustedCredits: -creditsDifference,
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
    // 谁问谁付: ingestion pages deduct from the acting member's own allocation.
    return this.accountService.withLockedAccount(
      teamId,
      actorUserId,
      async ({ account, client }) => {
        if (
          !this.runtimeConfig.pagesEnabled ||
          this.runtimeConfig.mode === "disabled"
        ) {
          return {
            teamId: account.teamId,
            pagesConsumed: 0,
            pagesUsed: account.pagesConsumedThisCycle,
            pagesRemaining: getAvailablePages(account),
            idempotencyReplayed: false,
          };
        }

        const idempotencyKey = input.idempotencyKey?.trim();
        if (idempotencyKey) {
          const existing = await this.store.getLedgerByIdempotency(
            account.teamId,
            scopeMemberLedgerKey(account.userId, idempotencyKey),
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
              pagesUsed: account.pagesConsumedThisCycle,
              pagesRemaining: getAvailablePages(account),
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

        consumePages(account, pagesToConsume);
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
            balanceAfter: getAvailablePages(account),
            feature: input.feature ?? DEFAULT_INGESTION_FEATURE,
            actorUserId,
            workspaceId: input.workspaceId,
            referenceId: input.referenceId,
            idempotencyKey,
            operationId:
              idempotencyKey ??
              (input.referenceId
                ? createOperationId("usage", account.teamId, input.referenceId)
                : undefined),
            operationType: "usage",
            activityVisible: true,
            activityTitle: "Pages indexed",
            activitySummary: formatSignedLedgerDelta("page", -pagesToConsume),
            metadata: {
              monthlyPagesGrant: account.monthlyPagesGrant,
              monthlyPagesBalance: account.monthlyPagesBalance,
              addOnPagesBalance: account.addOnPagesBalance,
              consumedThisCycle: account.pagesConsumedThisCycle,
            },
          },
        });

        return {
          teamId: account.teamId,
          pagesConsumed: pagesToConsume,
          pagesUsed: account.pagesConsumedThisCycle,
          pagesRemaining: getAvailablePages(account),
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
    const available = getAvailablePages(account);
    const decision = decidePageAdmission({
      availablePages: available,
      pagesToConsume,
      mode: this.runtimeConfig.mode,
      enforceLimits: this.runtimeConfig.enforceLimits,
    });

    if (decision.outcome === "admit") {
      return;
    }

    if (decision.outcome === "reject") {
      throw new BillingError(
        "PAGES_LIMIT_EXCEEDED",
        402,
        "Ingestion pages limit exceeded",
        {
          teamId: account.teamId,
          requested: pagesToConsume,
          available,
          monthlyPagesBalance: account.monthlyPagesBalance,
          addOnPagesBalance: account.addOnPagesBalance,
        },
      );
    }

    const missing = decision.missingPages;
    grantAddOnPages(account, missing);

    await appendBillingLedger({
      store: this.store,
      client,
      account,
      entry: {
        eventType: "grant",
        unitType: "page",
        delta: missing,
        balanceAfter: getTotalPagesBalance(account),
        feature: "shadow_auto_grant",
        actorUserId,
        metadata: {
          reason: "shadow_overage",
          originalFeature: feature ?? DEFAULT_INGESTION_FEATURE,
          monthlyPagesBalance: account.monthlyPagesBalance,
          addOnPagesBalance: account.addOnPagesBalance,
        },
      },
    });
  }
}
