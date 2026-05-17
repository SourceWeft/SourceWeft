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
export const subscriptionPlanFamilySchema = z.enum([
  "individual_pro",
  "team_standard",
]);

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

export const billingCycleSourceSchema = z.enum([
  "free_account",
  "provider_subscription",
  "manual",
]);

export const billingIntervalSchema = z.enum(["monthly", "yearly", "unknown"]);

export const ledgerEventTypeSchema = z.enum([
  "grant",
  "reserve",
  "consume",
  "release",
  "refund",
  "expire",
  "adjust",
]);

export const ledgerUnitTypeSchema = z.enum(["credit", "page", "seat"]);
export const topupUnitTypeSchema = z.enum(["credit", "page"]);

export const billingOperationTypeSchema = z.enum([
  "seat_change",
  "cycle_renewal",
  "plan_change",
  "topup",
  "usage",
  "quota_adjustment",
]);

export const billingOrderKindSchema = z.enum([
  "subscription",
  "credit_topup",
  "page_topup",
]);

export const billingOrderStatusSchema = z.enum([
  "pending",
  "checkout_created",
  "payment_confirmed",
  "fulfilled",
  "payment_failed",
  "expired",
  "fulfillment_failed",
]);

export const billingOrderPaymentStatusSchema = z.enum([
  "unknown",
  "unpaid",
  "paid",
  "failed",
  "expired",
]);

export const pricingCheckoutPlanSchema = z.enum(["pro", "team"]);

export const billingCheckoutSourceSchema = z.enum(["landing", "dashboard"]);

export const billingSummaryResponseSchema = z.object({
  teamId: z.string(),
  planFamily: planFamilySchema,
  billingMode: billingModeSchema,
  cycleAnchorAt: z.string(),
  cycleSource: billingCycleSourceSchema,
  cycleStartAt: z.string(),
  cycleEndAt: z.string(),
  pages: z.object({
    limit: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    monthlyGrant: z.number().int().nonnegative(),
    monthlyBalance: z.number().int().nonnegative(),
    addOnBalance: z.number().int().nonnegative(),
    consumedThisCycle: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
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
    activeMembers: z.number().int().nonnegative(),
    pendingInvitations: z.number().int().nonnegative(),
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
  operationId: z.string().nullable(),
  operationType: billingOperationTypeSchema.nullable(),
  activityVisible: z.boolean(),
  activityTitle: z.string().nullable(),
  activitySummary: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const billingLedgerResponseSchema = z.object({
  teamId: z.string(),
  items: z.array(billingLedgerEntrySchema),
  nextCursor: z.string().nullable().optional(),
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

export const createPricingCheckoutRequestSchema = z
  .object({
    plan: pricingCheckoutPlanSchema,
    billingInterval: z.enum(["monthly", "yearly"]).default("yearly"),
    clientReferenceKey: z.string().trim().min(1).max(160).optional(),
    source: billingCheckoutSourceSchema.default("dashboard"),
    teamName: z.string().trim().min(1).max(80).optional(),
    seatCount: z.number().int().min(2).max(99).optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.plan === "pro" && value.seatCount !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "seatCount is only supported for team pricing checkout",
        path: ["seatCount"],
      });
    }
  });

export const createPricingCheckoutResponseSchema = z.object({
  orderId: z.string(),
  provider: billingProviderSchema,
  checkoutUrl: z.string().url(),
  status: billingOrderStatusSchema,
  paymentStatus: billingOrderPaymentStatusSchema,
  teamId: z.string().nullable(),
  planFamily: subscriptionPlanFamilySchema,
  billingInterval: z.enum(["monthly", "yearly"]),
  quantity: z.number().int().positive(),
});

export const createTopupCheckoutRequestSchema = z
  .object({
    unitType: topupUnitTypeSchema.default("credit"),
    quantity: z.number().int().positive(),
    clientReferenceKey: z.string().trim().min(1).max(160).optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.quantity === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "quantity is required",
        path: ["quantity"],
      });
    }
  });

export const createTopupCheckoutResponseSchema = z.object({
  orderId: z.string(),
  teamId: z.string(),
  provider: billingProviderSchema,
  checkoutUrl: z.string().url(),
  status: billingOrderStatusSchema,
  paymentStatus: billingOrderPaymentStatusSchema,
  unitType: topupUnitTypeSchema,
  quantity: z.number().int().positive(),
  unitAmount: z.number().int().positive(),
  grantedCredits: z.number().int().nonnegative(),
  grantedPages: z.number().int().nonnegative(),
  amountUsd: z.number().nonnegative(),
});

export const billingOrderResponseSchema = z.object({
  id: z.string(),
  provider: billingProviderSchema,
  kind: billingOrderKindSchema,
  status: billingOrderStatusSchema,
  paymentStatus: billingOrderPaymentStatusSchema,
  userId: z.string(),
  teamId: z.string().nullable(),
  clientReferenceKey: z.string().nullable(),
  planFamily: planFamilySchema.nullable(),
  billingInterval: billingIntervalSchema.nullable(),
  quantity: z.number().int().positive(),
  unitType: topupUnitTypeSchema.nullable(),
  unitAmount: z.number().int().nonnegative().nullable(),
  grantedCredits: z.number().int().nonnegative(),
  grantedPages: z.number().int().nonnegative(),
  externalCheckoutId: z.string().nullable(),
  externalPaymentId: z.string().nullable(),
  externalCustomerId: z.string().nullable(),
  externalSubscriptionId: z.string().nullable(),
  externalProductId: z.string().nullable(),
  amountTotal: z.number().int().nonnegative().nullable(),
  currency: z.string().nullable(),
  successUrl: z.string().nullable(),
  cancelUrl: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  paidAt: z.string().nullable(),
  fulfilledAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  fulfillmentAttemptCount: z.number().int().nonnegative(),
  nextRetryAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const billingSubscriptionResponseSchema = z.object({
  teamId: z.string(),
  provider: billingProviderSchema,
  planFamily: planFamilySchema.nullable(),
  status: billingSubscriptionStatusSchema,
  billingInterval: billingIntervalSchema,
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  externalCustomerId: z.string().nullable(),
  externalSubscriptionId: z.string().nullable(),
  billingOrderId: z.string().nullable(),
  externalSubscriptionItemId: z.string().nullable(),
  lastEventAt: z.string().nullable(),
});

export const createTeamSubscriptionCheckoutRequestSchema = z
  .object({
    planFamily: subscriptionPlanFamilySchema.default("team_standard"),
    billingInterval: z.enum(["monthly", "yearly"]).default("yearly"),
    seatCount: z.number().int().min(2).max(99).optional(),
    successUrl: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.planFamily === "team_standard" && value.seatCount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "seatCount is required for team_standard subscriptions",
        path: ["seatCount"],
      });
    }

    if (
      value.planFamily === "individual_pro" &&
      value.seatCount !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "seatCount is only supported for team_standard subscriptions",
        path: ["seatCount"],
      });
    }
  });

export const createTeamSubscriptionCheckoutResponseSchema = z.object({
  teamId: z.string(),
  provider: billingProviderSchema,
  checkoutUrl: z.string().url(),
});

export const updateTeamSubscriptionSeatsRequestSchema = z.object({
  seatCount: z.number().int().min(2).max(99),
});

export const teamSubscriptionSeatQuotaAdjustmentSchema = z.object({
  removedSeats: z.number().int().nonnegative(),
  remainingRatio: z.number().min(0).max(1),
  targetCredits: z.number().int().nonnegative(),
  actualCredits: z.number().int().nonnegative(),
  targetPages: z.number().int().nonnegative(),
  actualPages: z.number().int().nonnegative(),
  creditRecoverRatio: z.number().min(0).max(1),
  pageRecoverRatio: z.number().min(0).max(1),
  refundRatio: z.number().min(0).max(1),
});

export const teamSubscriptionSeatBillingAdjustmentSchema = z.object({
  theoreticalRefundCents: z.number().int().nonnegative(),
  actualRefundCents: z.number().int().nonnegative(),
  unrefundedCents: z.number().int().nonnegative(),
  estimatedChargeCents: z.number().int().nonnegative(),
  currency: z.string(),
  providerAction: z.enum([
    "none",
    "proration_charge_immediately",
    "proration_credit",
    "internal_partial_credit",
  ]),
});

export const previewTeamSubscriptionSeatsResponseSchema = z.object({
  teamId: z.string(),
  provider: billingProviderSchema,
  currentSeatCount: z.number().int().min(1),
  seatCount: z.number().int().min(2),
  seatsUsed: z.number().int().nonnegative(),
  pendingInvitations: z.number().int().nonnegative(),
  quotaAdjustment: teamSubscriptionSeatQuotaAdjustmentSchema.nullable(),
  billingAdjustment: teamSubscriptionSeatBillingAdjustmentSchema.nullable(),
});

export const updateTeamSubscriptionSeatsResponseSchema = z.object({
  teamId: z.string(),
  provider: billingProviderSchema,
  seatCount: z.number().int().min(2),
  seatsUsed: z.number().int().nonnegative(),
  pendingInvitations: z.number().int().nonnegative(),
  quotaAdjustment: teamSubscriptionSeatQuotaAdjustmentSchema.nullable(),
  billingAdjustment: teamSubscriptionSeatBillingAdjustmentSchema.nullable(),
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
  portalUrl: z.string().url().nullable(),
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
    modelKind: z.string().optional(),
    operation: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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
export type SubscriptionPlanFamily = z.infer<
  typeof subscriptionPlanFamilySchema
>;
export type BillingCycleSource = z.infer<typeof billingCycleSourceSchema>;
export type BillingInterval = z.infer<typeof billingIntervalSchema>;
export type BillingSubscriptionStatus = z.infer<
  typeof billingSubscriptionStatusSchema
>;
export type LedgerEventType = z.infer<typeof ledgerEventTypeSchema>;
export type LedgerUnitType = z.infer<typeof ledgerUnitTypeSchema>;
export type TopupUnitType = z.infer<typeof topupUnitTypeSchema>;
export type BillingOperationType = z.infer<typeof billingOperationTypeSchema>;
export type BillingOrderKind = z.infer<typeof billingOrderKindSchema>;
export type BillingOrderStatus = z.infer<typeof billingOrderStatusSchema>;
export type BillingOrderPaymentStatus = z.infer<
  typeof billingOrderPaymentStatusSchema
>;
export type PricingCheckoutPlan = z.infer<typeof pricingCheckoutPlanSchema>;
export type BillingCheckoutSource = z.infer<typeof billingCheckoutSourceSchema>;
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
export type CreatePricingCheckoutRequest = z.infer<
  typeof createPricingCheckoutRequestSchema
>;
export type CreatePricingCheckoutResponse = z.infer<
  typeof createPricingCheckoutResponseSchema
>;
export type CreateTopupCheckoutRequest = z.infer<
  typeof createTopupCheckoutRequestSchema
>;
export type CreateTopupCheckoutResponse = z.infer<
  typeof createTopupCheckoutResponseSchema
>;
export type BillingOrderResponse = z.infer<typeof billingOrderResponseSchema>;
export type BillingSubscriptionResponse = z.infer<
  typeof billingSubscriptionResponseSchema
>;
export type CreateTeamSubscriptionCheckoutRequest = z.infer<
  typeof createTeamSubscriptionCheckoutRequestSchema
>;
export type CreateTeamSubscriptionCheckoutResponse = z.infer<
  typeof createTeamSubscriptionCheckoutResponseSchema
>;
export type UpdateTeamSubscriptionSeatsRequest = z.infer<
  typeof updateTeamSubscriptionSeatsRequestSchema
>;
export type TeamSubscriptionSeatQuotaAdjustment = z.infer<
  typeof teamSubscriptionSeatQuotaAdjustmentSchema
>;
export type TeamSubscriptionSeatBillingAdjustment = z.infer<
  typeof teamSubscriptionSeatBillingAdjustmentSchema
>;
export type PreviewTeamSubscriptionSeatsResponse = z.infer<
  typeof previewTeamSubscriptionSeatsResponseSchema
>;
export type UpdateTeamSubscriptionSeatsResponse = z.infer<
  typeof updateTeamSubscriptionSeatsResponseSchema
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
