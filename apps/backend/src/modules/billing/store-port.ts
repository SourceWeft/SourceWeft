import type { PoolClient } from "pg";
import type {
  BillingAccountState,
  BillingLedgerRow,
  BillingSubscriptionState,
  BillingWebhookEventState,
  BillingWebhookStatus,
  TeamSubscriptionSnapshot,
} from "./types";

export type BillingStore = {
  runInTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  getAccount(
    teamId: string,
    client?: PoolClient,
  ): Promise<BillingAccountState | null>;
  getAccountForUpdate(
    teamId: string,
    client: PoolClient,
  ): Promise<BillingAccountState | null>;
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
    client?: PoolClient,
  ): Promise<BillingLedgerRow[]>;
  countTeamMembers(teamId: string, client?: PoolClient): Promise<number>;
  getSubscriptionByTeam(
    teamId: string,
    client?: PoolClient,
  ): Promise<BillingSubscriptionState | null>;
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
      subscriptionStatus: BillingSubscriptionState["status"] | null;
      externalSubscriptionId: string | null;
    }>
  >;
};
