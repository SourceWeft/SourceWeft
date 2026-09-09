import type {
  BillingMode,
  BillingProvider,
  BillingScope,
  PlanFamily,
} from "@sourceweft/credits-core";
import type {
  BillingCycleSource,
  BillingInterval,
  BillingOrderKind,
  BillingOrderPaymentStatus,
  BillingOrderResponse,
  BillingOrderStatus,
  SubscriptionPlanFamily,
  BillingSubscriptionStatus,
  BillingLedgerEntry,
  TopupUnitType,
} from "@sourceweft/contracts";

export type BillingRuntimeConfig = {
  saasEnabled: boolean;
  mode: BillingMode;
  scope: BillingScope;
  provider: BillingProvider;
  creditsEnabled: boolean;
  pagesEnabled: boolean;
  enforceLimits: boolean;
  teamBillingEnabled: boolean;
  creditUnitUsd: number;
  defaultMarkupRate: number;
  defaultPlanFamily: PlanFamily;
  defaultMonthlyPages: number;
  defaultMonthlyCredits: number;
  reconcileEnabled: boolean;
  creem: {
    apiKey: string;
    webhookSecret: string;
    testMode: boolean;
    individualProMonthlyProductId: string;
    individualProYearlyProductId: string;
    teamStandardMonthlyProductId: string;
    teamStandardYearlyProductId: string;
    creditTopupProductId: string;
    pageTopupProductId: string;
  };
  catalog: {
    individualProMonthlyAmountCents: number;
    individualProYearlyAmountCents: number;
    teamStandardMonthlyAmountCents: number;
    teamStandardYearlyAmountCents: number;
    creditTopupUnitAmount: number;
    creditTopupAmountCents: number;
    pageTopupUnitAmount: number;
    pageTopupAmountCents: number;
  };
  defaultSuccessUrl: string;
};

export type BillingAccountState = {
  teamId: string;
  // Per-member allocation: each account row is keyed on (teamId, userId).
  // A member's runs settle against their own row (谁问谁付, deduct own first).
  userId: string;
  planFamily: PlanFamily;
  cycleAnchorAt: string;
  cycleSource: BillingCycleSource;
  cycleStartAt: string;
  cycleEndAt: string;
  pagesLimit: number;
  pagesUsed: number;
  monthlyPagesGrant: number;
  monthlyPagesBalance: number;
  addOnPagesBalance: number;
  pagesConsumedThisCycle: number;
  monthlyCreditsGrant: number;
  monthlyCreditsBalance: number;
  addOnCreditsBalance: number;
  creditsReserved: number;
  creditsConsumedThisCycle: number;
  seatCount: number;
  spendSoftCapUsd: number | null;
  spendHardCapUsd: number | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingLedgerRow = BillingLedgerEntry;

export type BillingSubscriptionState = {
  id: string;
  teamId: string;
  provider: BillingProvider;
  planFamily: PlanFamily;
  status: BillingSubscriptionStatus;
  billingInterval: BillingInterval;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  externalSubscriptionItemId: string | null;
  externalProductId: string | null;
  billingOrderId: string | null;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, unknown>;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingOrderState = BillingOrderResponse;

export type BillingWebhookStatus =
  "received" | "processed" | "ignored" | "failed";

export type BillingWebhookEventState = {
  id: string;
  provider: BillingProvider;
  providerEventId: string | null;
  eventType: string;
  teamId: string | null;
  externalSubscriptionId: string | null;
  status: BillingWebhookStatus;
  attemptCount: number;
  receivedAt: string;
  processedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type BillingWebhookProcessInput = {
  provider: BillingProvider;
  providerEventId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  teamId: string | null;
  externalSubscriptionId: string | null;
  metadata?: Record<string, unknown>;
  snapshot: TeamSubscriptionSnapshot | null;
  orderFulfillment?: {
    orderId: string;
    externalPaymentId?: string | null;
    externalCustomerId?: string | null;
    externalSubscriptionId?: string | null;
    externalSubscriptionItemId?: string | null;
    externalProductId?: string | null;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
    status?: BillingSubscriptionStatus;
    metadata?: Record<string, unknown>;
  } | null;
};

export type BillingWebhookProcessOutcome =
  "processed" | "ignored" | "duplicate";

export type BillingWebhookProcessResult = {
  outcome: BillingWebhookProcessOutcome;
  webhookEvent: BillingWebhookEventState;
  reason?: string;
};

export type TeamSubscriptionSnapshot = {
  teamId: string;
  provider: BillingProvider;
  planFamily: PlanFamily;
  status: BillingSubscriptionStatus;
  billingInterval: BillingInterval;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  externalSubscriptionItemId?: string | null;
  externalProductId: string | null;
  billingOrderId?: string | null;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, unknown>;
  seatCount: number;
};

export type TeamPlanReconcileAnomaly = {
  teamId: string;
  previousPlanFamily: PlanFamily;
  expectedPlanFamily: PlanFamily;
  subscriptionStatus: BillingSubscriptionStatus;
  externalSubscriptionId: string | null;
};

export type TeamPlanReconcileResult = {
  checked: number;
  realigned: number;
  anomalies: TeamPlanReconcileAnomaly[];
};

export type BillingProviderCheckoutInput = {
  orderId: string;
  persistedOrder?: boolean;
  kind: BillingOrderKind;
  teamId: string | null;
  actorUserId: string;
  actorEmail: string;
  planFamily: SubscriptionPlanFamily | null;
  billingInterval: Exclude<BillingInterval, "unknown"> | null;
  quantity: number;
  unitType?: TopupUnitType | null;
  unitAmount?: number | null;
  grantedCredits?: number;
  grantedPages?: number;
  externalProductId: string;
  amountTotal?: number | null;
  currency?: string | null;
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
};

export type BillingProviderCheckoutResult = {
  provider: BillingProvider;
  checkoutUrl: string;
  externalCheckoutId: string | null;
  externalCustomerId: string | null;
};

export type BillingProviderPortalInput = {
  teamId: string;
  actorUserId: string;
  externalCustomerId?: string | null;
  externalSubscriptionId?: string | null;
};

export type BillingProviderPortalResult = {
  provider: BillingProvider;
  portalUrl: string | null;
};

export type BillingProviderUpdateSeatsInput = {
  teamId: string;
  actorUserId?: string | null;
  externalSubscriptionId: string;
  externalProductId?: string | null;
  seatCount: number;
  updateBehavior:
    "proration-charge-immediately" | "proration-charge" | "proration-none";
};

export type BillingProviderUpdateSeatsResult = {
  provider: BillingProvider;
  seatCount: number;
};

export type BillingProviderAdapter = {
  createCheckout(
    input: BillingProviderCheckoutInput,
  ): Promise<BillingProviderCheckoutResult>;
  createPortal(
    input: BillingProviderPortalInput,
  ): Promise<BillingProviderPortalResult>;
  updateSubscriptionSeats(
    input: BillingProviderUpdateSeatsInput,
  ): Promise<BillingProviderUpdateSeatsResult>;
};
