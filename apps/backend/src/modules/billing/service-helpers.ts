import { createHash } from "node:crypto";
import type {
  BillingSubscriptionResponse,
  BillingSubscriptionStatus,
  BillingSummaryResponse,
} from "@sourceweft/contracts";
import type { PlanFamily } from "@sourceweft/credits-core";
import { BillingError } from "./errors";
import type {
  BillingAccountState,
  BillingRuntimeConfig,
  BillingSubscriptionState,
  BillingWebhookProcessInput,
} from "./types";

export const DEFAULT_CONSUME_FEATURE = "chat";
export const DEFAULT_INGESTION_FEATURE = "ingestion";
export const TEAM_STANDARD_PLAN = "team_standard" as const;
export const INDIVIDUAL_PRO_PLAN = "individual_pro" as const;

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  "active",
  "past_due",
]);

export function ensureTeamBillingEnabled(runtimeConfig: BillingRuntimeConfig) {
  if (!runtimeConfig.teamBillingEnabled) {
    throw new BillingError(
      "TEAM_BILLING_DISABLED",
      409,
      "Team billing is disabled",
    );
  }
}

export function toWebhookError(error: unknown): { code: string; message: string } {
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

export function toSubscriptionSummary(input: {
  account: BillingAccountState;
  subscription: BillingSubscriptionState | null;
  provider: BillingRuntimeConfig["provider"];
}): BillingSubscriptionResponse {
  return {
    teamId: input.account.teamId,
    provider: input.subscription?.provider ?? input.provider,
    planFamily: input.subscription?.planFamily ?? input.account.planFamily,
    status: input.subscription?.status ?? "inactive",
    billingInterval: input.subscription?.billingInterval ?? "unknown",
    currentPeriodStart: input.subscription?.currentPeriodStart ?? null,
    currentPeriodEnd: input.subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: input.subscription?.cancelAtPeriodEnd ?? false,
    externalCustomerId: input.subscription?.externalCustomerId ?? null,
    externalSubscriptionId: input.subscription?.externalSubscriptionId ?? null,
    billingOrderId: input.subscription?.billingOrderId ?? null,
    externalSubscriptionItemId:
      input.subscription?.externalSubscriptionItemId ?? null,
    lastEventAt: input.subscription?.lastEventAt ?? null,
  };
}

export function resolvePlanFromSubscription(input: {
  status: BillingSubscriptionStatus;
  planFamily: PlanFamily;
  defaultPlanFamily: PlanFamily;
}) {
  if (ACTIVE_SUBSCRIPTION_STATUSES.has(input.status)) {
    return input.planFamily;
  }

  return input.defaultPlanFamily;
}

export function spendCredits(
  account: BillingAccountState,
  creditsToConsume: number,
) {
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

export function getTotalCreditsBalance(account: BillingAccountState) {
  return account.monthlyCreditsBalance + account.addOnCreditsBalance;
}

export function getAvailableCredits(account: BillingAccountState) {
  const available = getTotalCreditsBalance(account) - account.creditsReserved;
  return Math.max(available, 0);
}

export function spendPages(
  account: BillingAccountState,
  pagesToConsume: number,
) {
  let remaining = pagesToConsume;

  if (account.monthlyPagesBalance > 0) {
    const fromMonthly = Math.min(account.monthlyPagesBalance, remaining);
    account.monthlyPagesBalance -= fromMonthly;
    remaining -= fromMonthly;
  }

  if (remaining > 0 && account.addOnPagesBalance > 0) {
    const fromAddOn = Math.min(account.addOnPagesBalance, remaining);
    account.addOnPagesBalance -= fromAddOn;
    remaining -= fromAddOn;
  }

  if (remaining > 0) {
    throw new BillingError(
      "INSUFFICIENT_PAGES_INTERNAL",
      500,
      "Unable to allocate page buckets for consumption",
    );
  }
}

export function getTotalPagesBalance(account: BillingAccountState) {
  return account.monthlyPagesBalance + account.addOnPagesBalance;
}

export function getAvailablePages(account: BillingAccountState) {
  return Math.max(getTotalPagesBalance(account), 0);
}

export function getPagesRemaining(account: BillingAccountState) {
  return getAvailablePages(account);
}

export function toSummary(input: {
  account: BillingAccountState;
  billingMode: BillingRuntimeConfig["mode"];
  seatsUsed?: number;
}): BillingSummaryResponse {
  const pagesRemaining = getAvailablePages(input.account);
  const seatsUsed = Math.max(0, Math.floor(input.seatsUsed ?? 0));
  const seatsLimit = Math.max(0, input.account.seatCount);

  return {
    teamId: input.account.teamId,
    planFamily: input.account.planFamily,
    billingMode: input.billingMode,
    cycleAnchorAt: input.account.cycleAnchorAt,
    cycleSource: input.account.cycleSource,
    cycleStartAt: input.account.cycleStartAt,
    cycleEndAt: input.account.cycleEndAt,
    pages: {
      limit: input.account.pagesLimit,
      used: input.account.pagesConsumedThisCycle,
      remaining: pagesRemaining,
      monthlyGrant: input.account.monthlyPagesGrant,
      monthlyBalance: input.account.monthlyPagesBalance,
      addOnBalance: input.account.addOnPagesBalance,
      consumedThisCycle: input.account.pagesConsumedThisCycle,
      available: getAvailablePages(input.account),
    },
    credits: {
      monthlyGrant: input.account.monthlyCreditsGrant,
      monthlyBalance: input.account.monthlyCreditsBalance,
      addOnBalance: input.account.addOnCreditsBalance,
      reserved: input.account.creditsReserved,
      consumedThisCycle: input.account.creditsConsumedThisCycle,
      available: getAvailableCredits(input.account),
    },
    seats: {
      used: seatsUsed,
      limit: seatsLimit,
      remaining: Math.max(seatsLimit - seatsUsed, 0),
    },
    spendLimits: {
      softCapUsd: input.account.spendSoftCapUsd,
      hardCapUsd: input.account.spendHardCapUsd,
    },
  };
}

export function normalizeTeamId(teamId: string) {
  const value = teamId.trim();
  if (!value) {
    throw new BillingError("INVALID_TEAM_ID", 400, "teamId is required");
  }

  return value;
}

export function stableSerialize(value: unknown): string {
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
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`,
    );
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(String(value));
}

export function createFallbackWebhookEventId(input: BillingWebhookProcessInput) {
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
    .update(stableSerialize(seed))
    .digest("hex")
    .slice(0, 32);

  return `fallback:${digest}`;
}
