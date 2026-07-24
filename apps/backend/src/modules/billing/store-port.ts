import type { PoolClient } from "pg";
import type {
  BillingAccountState,
  BillingLedgerRow,
  BillingOrderState,
  BillingSubscriptionState,
  BillingWebhookEventState,
  BillingWebhookStatus,
  TeamSubscriptionSnapshot,
} from "./types";

export type BillingStore = {
  runInTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  getAccount(
    teamId: string,
    userId: string,
    client?: PoolClient,
  ): Promise<BillingAccountState | null>;
  getAccountForUpdate(
    teamId: string,
    userId: string,
    client: PoolClient,
  ): Promise<BillingAccountState | null>;
  getTeamAccountsForUpdate(
    teamId: string,
    client: PoolClient,
  ): Promise<BillingAccountState[]>;
  getAnyTeamAccount(
    teamId: string,
    client?: PoolClient,
  ): Promise<BillingAccountState | null>;
  listTeamMemberUserIds(teamId: string, client?: PoolClient): Promise<string[]>;
  insertAccount(
    account: BillingAccountState,
    client: PoolClient,
  ): Promise<void>;
  updateAccount(
    account: BillingAccountState,
    client: PoolClient,
  ): Promise<void>;
  appendLedger(entry: BillingLedgerRow, client: PoolClient): Promise<void>;
  getLedgerByIdempotency(
    teamId: string,
    idempotencyKey: string,
    client?: PoolClient,
  ): Promise<BillingLedgerRow | null>;
  listLedger(
    teamId: string,
    limit?: number,
    options?: {
      activityOnly?: boolean;
      actorUserId?: string;
      cursor?: { createdAt: Date; id: string } | null;
    },
    client?: PoolClient,
  ): Promise<BillingLedgerRow[]>;
  getOrderById(
    orderId: string,
    client?: PoolClient,
  ): Promise<BillingOrderState | null>;
  getOrderByIdForUpdate(
    orderId: string,
    client: PoolClient,
  ): Promise<BillingOrderState | null>;
  getOrderByClientReference(
    userId: string,
    clientReferenceKey: string,
    client?: PoolClient,
  ): Promise<BillingOrderState | null>;
  getOrderByProviderCheckoutId(
    provider: BillingOrderState["provider"],
    externalCheckoutId: string,
    client?: PoolClient,
  ): Promise<BillingOrderState | null>;
  insertOrder(
    order: BillingOrderState,
    client?: PoolClient,
  ): Promise<BillingOrderState>;
  updateOrder(
    order: BillingOrderState,
    client?: PoolClient,
  ): Promise<BillingOrderState>;
  findOpenSubscriptionOrder(
    input: {
      userId: string;
      teamId: string | null;
      planFamily: BillingOrderState["planFamily"];
      billingInterval: BillingOrderState["billingInterval"];
    },
    client?: PoolClient,
  ): Promise<BillingOrderState | null>;
  listRetryableOrders(
    input?: { limit?: number },
    client?: PoolClient,
  ): Promise<BillingOrderState[]>;
  countTeamMembers(teamId: string, client?: PoolClient): Promise<number>;
  countPendingTeamInvitations(
    teamId: string,
    client?: PoolClient,
  ): Promise<number>;
  getSubscriptionByTeam(
    teamId: string,
    client?: PoolClient,
  ): Promise<BillingSubscriptionState | null>;
  getSubscriptionByProviderSubscription(
    provider: BillingSubscriptionState["provider"],
    externalSubscriptionId: string,
    client?: PoolClient,
  ): Promise<BillingSubscriptionState | null>;
  getLatestCustomerSubscriptionByUser(
    userId: string,
    client?: PoolClient,
  ): Promise<BillingSubscriptionState | null>;
  getLatestCustomerOrderByUser(
    userId: string,
    client?: PoolClient,
  ): Promise<BillingOrderState | null>;
  upsertSubscription(
    snapshot: TeamSubscriptionSnapshot,
    client: PoolClient,
  ): Promise<BillingSubscriptionState>;
  getWebhookEventByProviderEventId(
    provider: BillingWebhookEventState["provider"],
    providerEventId: string,
    client?: PoolClient,
  ): Promise<BillingWebhookEventState | null>;
  insertWebhookEvent(
    input: {
      provider: BillingWebhookEventState["provider"];
      providerEventId: string;
      eventType: string;
      teamId: string | null;
      externalSubscriptionId: string | null;
      payload: Record<string, unknown>;
      metadata: Record<string, unknown>;
    },
    client?: PoolClient,
  ): Promise<BillingWebhookEventState>;
  incrementWebhookEventAttempt(
    webhookEventId: string,
    input: {
      eventType: string;
      teamId: string | null;
      externalSubscriptionId: string | null;
      payload: Record<string, unknown>;
      metadata: Record<string, unknown>;
    },
    client?: PoolClient,
  ): Promise<BillingWebhookEventState>;
  updateWebhookEventState(
    webhookEventId: string,
    input: {
      status: BillingWebhookStatus;
      teamId?: string | null;
      externalSubscriptionId?: string | null;
      processedAt?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      metadata?: Record<string, unknown>;
    },
    client?: PoolClient,
  ): Promise<BillingWebhookEventState>;
  listAccountSubscriptionStates(client?: PoolClient): Promise<
    Array<{
      teamId: string;
      accountPlanFamily: BillingAccountState["planFamily"];
      subscriptionPlanFamily: BillingSubscriptionState["planFamily"] | null;
      subscriptionStatus: BillingSubscriptionState["status"] | null;
      externalSubscriptionId: string | null;
    }>
  >;
};
