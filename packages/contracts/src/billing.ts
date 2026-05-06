import { z } from "zod";
import { apiErrorResponseSchema } from "./api-response";

export const planFamilySchema = z.enum([
  "individual_free",
  "individual_pro",
  "team_standard",
  "team_premium",
  "enterprise_usage",
]);

export const billingModeSchema = z.enum(["disabled", "shadow", "enforced"]);

export const billingProviderSchema = z.enum([
  "none",
  "creem",
  "stripe",
  "manual",
]);

export const teamPlanFamilySchema = z.enum(["team_standard"]);

export const billingSubscriptionStatusSchema = z.enum([
  "inactive",
  "trialing",
  "active",
  "past_due",
  "paused",
  "unpaid",
  "canceled",
  "expired",
]);

export const ledgerEventTypeSchema = z.enum([
  "grant",
  "reserve",
  "consume",
  "release",
  "refund",
  "expire",
  "adjust",
]);

export const ledgerUnitTypeSchema = z.enum(["credit", "page"]);

export const billingSummaryResponseSchema = z.object({
  teamId: z.string(),
  planFamily: planFamilySchema,
  billingMode: billingModeSchema,
  cycleStartAt: z.string(),
  cycleEndAt: z.string(),
  pages: z.object({
    limit: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
  credits: z.object({
    monthlyGrant: z.number().int().nonnegative(),
    monthlyBalance: z.number().int().nonnegative(),
    addOnBalance: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    consumedThisCycle: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
  }),
  seats: z.object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
  spendLimits: z.object({
    softCapUsd: z.number().nonnegative().nullable(),
    hardCapUsd: z.number().nonnegative().nullable(),
  }),
});

export const billingUsageItemSchema = z.object({
  feature: z.string(),
  creditsConsumed: z.number().int().nonnegative(),
  pagesConsumed: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
});

export const billingUsageResponseSchema = z.object({
  teamId: z.string(),
  cycleStartAt: z.string(),
  cycleEndAt: z.string(),
  totals: z.object({
    creditsConsumed: z.number().int().nonnegative(),
    pagesConsumed: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  }),
  items: z.array(billingUsageItemSchema),
});

export const billingLedgerEntrySchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  feature: z.string(),
  eventType: ledgerEventTypeSchema,
  unitType: ledgerUnitTypeSchema,
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  referenceId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const billingLedgerResponseSchema = z.object({
  teamId: z.string(),
  items: z.array(billingLedgerEntrySchema),
});

export const updateSpendLimitsRequestSchema = z
  .object({
    softCapUsd: z.number().nonnegative().nullable().optional(),
    hardCapUsd: z.number().nonnegative().nullable().optional(),
  })
  .refine(
    (value) => value.softCapUsd !== undefined || value.hardCapUsd !== undefined,
    {
      message: "At least one spend limit field is required",
    },
  );

export const updateSpendLimitsResponseSchema = z.object({
  teamId: z.string(),
  softCapUsd: z.number().nonnegative().nullable(),
  hardCapUsd: z.number().nonnegative().nullable(),
});

export const createTopupCheckoutRequestSchema = z.object({
  credits: z.number().int().positive(),
});

export const createTopupCheckoutResponseSchema = z.object({
  teamId: z.string(),
  provider: billingProviderSchema,
  status: z.enum(["completed", "pending"]),
  credits: z.number().int().positive(),
  amountUsd: z.number().nonnegative(),
});

export const billingSubscriptionResponseSchema = z.object({
  teamId: z.string(),
  provider: billingProviderSchema,
  planFamily: planFamilySchema.nullable(),
  status: billingSubscriptionStatusSchema,
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  externalCustomerId: z.string().nullable(),
  externalSubscriptionId: z.string().nullable(),
  lastEventAt: z.string().nullable(),
});

export const createTeamSubscriptionCheckoutRequestSchema = z.object({
  planFamily: z.literal("team_standard").default("team_standard"),
  seatCount: z.number().int().min(2).max(20),
  successUrl: z.string().url().optional(),
});

export const createTeamSubscriptionCheckoutResponseSchema = z.object({
  teamId: z.string(),
  provider: billingProviderSchema,
  checkoutUrl: z.string().url(),
});

export const createTeamBillingPortalResponseSchema = z.object({
  teamId: z.string(),
  provider: billingProviderSchema,
  portalUrl: z.string().url().nullable(),
});

export const cancelTeamSubscriptionResponseSchema = z.object({
  teamId: z.string(),
  status: billingSubscriptionStatusSchema,
  cancelAtPeriodEnd: z.boolean(),
});

export const meterConsumeRequestSchema = z
  .object({
    workspaceId: z.string().optional(),
    feature: z.string().optional(),
    referenceId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    credits: z.number().int().positive().optional(),
    providerCostUsd: z.number().nonnegative().optional(),
    platformCostUsd: z.number().nonnegative().optional(),
    markupRate: z.number().nonnegative().optional(),
  })
  .refine(
    (value) =>
      value.credits !== undefined || value.providerCostUsd !== undefined,
    {
      message: "Either credits or providerCostUsd is required",
    },
  );

export const meterConsumeResponseSchema = z.object({
  teamId: z.string(),
  consumedCredits: z.number().int().nonnegative(),
  availableCredits: z.number().int().nonnegative(),
  consumedThisCycle: z.number().int().nonnegative(),
  idempotencyReplayed: z.boolean(),
});

export const meterIngestionRequestSchema = z
  .object({
    workspaceId: z.string().optional(),
    feature: z.string().optional(),
    referenceId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    pages: z.number().int().positive().optional(),
    parsedTokens: z.number().int().positive().optional(),
  })
  .refine(
    (value) => value.pages !== undefined || value.parsedTokens !== undefined,
    {
      message: "Either pages or parsedTokens is required",
    },
  );

export const meterIngestionResponseSchema = z.object({
  teamId: z.string(),
  pagesConsumed: z.number().int().nonnegative(),
  pagesUsed: z.number().int().nonnegative(),
  pagesRemaining: z.number().int().nonnegative(),
  idempotencyReplayed: z.boolean(),
});

export const billingErrorResponseSchema = apiErrorResponseSchema;

export type PlanFamily = z.infer<typeof planFamilySchema>;
export type BillingMode = z.infer<typeof billingModeSchema>;
export type BillingProvider = z.infer<typeof billingProviderSchema>;
export type TeamPlanFamily = z.infer<typeof teamPlanFamilySchema>;
export type BillingSubscriptionStatus = z.infer<
  typeof billingSubscriptionStatusSchema
>;
export type LedgerEventType = z.infer<typeof ledgerEventTypeSchema>;
export type LedgerUnitType = z.infer<typeof ledgerUnitTypeSchema>;
export type BillingSummaryResponse = z.infer<
  typeof billingSummaryResponseSchema
>;
export type BillingUsageItem = z.infer<typeof billingUsageItemSchema>;
export type BillingUsageResponse = z.infer<typeof billingUsageResponseSchema>;
export type BillingLedgerEntry = z.infer<typeof billingLedgerEntrySchema>;
export type BillingLedgerResponse = z.infer<typeof billingLedgerResponseSchema>;
export type UpdateSpendLimitsRequest = z.infer<
  typeof updateSpendLimitsRequestSchema
>;
export type UpdateSpendLimitsResponse = z.infer<
  typeof updateSpendLimitsResponseSchema
>;
export type CreateTopupCheckoutRequest = z.infer<
  typeof createTopupCheckoutRequestSchema
>;
export type CreateTopupCheckoutResponse = z.infer<
  typeof createTopupCheckoutResponseSchema
>;
export type BillingSubscriptionResponse = z.infer<
  typeof billingSubscriptionResponseSchema
>;
export type CreateTeamSubscriptionCheckoutRequest = z.infer<
  typeof createTeamSubscriptionCheckoutRequestSchema
>;
export type CreateTeamSubscriptionCheckoutResponse = z.infer<
  typeof createTeamSubscriptionCheckoutResponseSchema
>;
export type CreateTeamBillingPortalResponse = z.infer<
  typeof createTeamBillingPortalResponseSchema
>;
export type CancelTeamSubscriptionResponse = z.infer<
  typeof cancelTeamSubscriptionResponseSchema
>;
export type MeterConsumeRequest = z.infer<typeof meterConsumeRequestSchema>;
export type MeterConsumeResponse = z.infer<typeof meterConsumeResponseSchema>;
export type MeterIngestionRequest = z.infer<typeof meterIngestionRequestSchema>;
export type MeterIngestionResponse = z.infer<
  typeof meterIngestionResponseSchema
>;
export type BillingErrorResponse = z.infer<typeof billingErrorResponseSchema>;
