import type {
  BillingMode,
  BillingProvider,
  BillingScope,
  PlanFamily,
} from "@sourceweft/credits-core";
import type {
  BillingSubscriptionStatus,
  BillingLedgerEntry,
  BillingSubscriptionResponse,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
} from "@sourceweft/contracts";

export type BillingRuntimeConfig = {
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
  cycleAnchorDay: number;
  reconcileEnabled: boolean;
  creem: {
    apiKey: string;
    webhookSecret: string;
    testMode: boolean;
    teamStandardProductId: string;
    defaultSuccessUrl: string;
  };
};

export type BillingAccountState = {
  teamId: string;
  planFamily: PlanFamily;
  cycleAnchorDay: number;
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
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  externalProductId: string | null;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, unknown>;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingWebhookStatus =
  | "received"
  | "processed"
  | "ignored"
  | "failed";

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
};

export type BillingWebhookProcessOutcome =
  | "processed"
  | "ignored"
  | "duplicate";

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
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  externalProductId: string | null;
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
  teamId: string;
  actorUserId: string;
  actorEmail: string;
  planFamily: "team_standard";
  seatCount: number;
  successUrl?: string;
};

export type BillingProviderCheckoutResult = {
  provider: BillingProvider;
  checkoutUrl: string;
};

export type BillingProviderPortalInput = {
  teamId: string;
  actorUserId: string;
  externalCustomerId?: string | null;
};

export type BillingProviderPortalResult = {
  provider: BillingProvider;
  portalUrl: string | null;
};

export type BillingProviderCancelInput = {
  teamId: string;
  actorUserId: string;
  externalSubscriptionId: string;
};

export type BillingProviderCancelResult = {
  provider: BillingProvider;
  status: BillingSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
};

export type BillingProviderAdapter = {
  createCheckout(
    input: BillingProviderCheckoutInput,
  ): Promise<BillingProviderCheckoutResult>;
  createPortal(
    input: BillingProviderPortalInput,
  ): Promise<BillingProviderPortalResult>;
  cancelSubscription(
    input: BillingProviderCancelInput,
  ): Promise<BillingProviderCancelResult>;
};

export type TeamSubscriptionSummary = BillingSubscriptionResponse;
export type TeamSubscriptionCheckoutInput =
  CreateTeamSubscriptionCheckoutRequest;
export type TeamSubscriptionCheckoutResult =
  CreateTeamSubscriptionCheckoutResponse;
export type TeamSubscriptionPortalResult = CreateTeamBillingPortalResponse;
export type TeamSubscriptionCancelResult = CancelTeamSubscriptionResponse;
