import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@sourceweft/db/schema";
import {
  billingAccounts,
  billingOrders,
  billingWebhookEvents,
  subscriptions,
  usageLedgers,
} from "@sourceweft/db/schema";
import type {
  BillingAccountState,
  BillingLedgerRow,
  BillingOrderState,
  BillingSubscriptionState,
  BillingWebhookEventState,
  BillingWebhookStatus,
  TeamSubscriptionSnapshot,
} from "./types";
import type { BillingStore } from "./store-port";

type BillingAccountRow = typeof billingAccounts.$inferSelect;
type BillingLedgerRowDb = typeof usageLedgers.$inferSelect;
type BillingOrderRow = typeof billingOrders.$inferSelect;
type BillingSubscriptionRow = typeof subscriptions.$inferSelect;
type BillingWebhookEventRow = typeof billingWebhookEvents.$inferSelect;

function toNumberOrNull(value: string | null) {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapAccount(row: BillingAccountRow): BillingAccountState {
  return {
    teamId: row.teamId,
    userId: row.userId,
    planFamily: row.planFamily,
    cycleAnchorAt: row.cycleAnchorAt.toISOString(),
    cycleSource: row.cycleSource,
    cycleStartAt: row.cycleStartAt.toISOString(),
    cycleEndAt: row.cycleEndAt.toISOString(),
    pagesLimit: row.pagesLimit,
    pagesUsed: row.pagesUsed,
    monthlyPagesGrant: row.monthlyPagesGrant,
    monthlyPagesBalance: row.monthlyPagesBalance,
    addOnPagesBalance: row.addOnPagesBalance,
    pagesConsumedThisCycle: row.pagesConsumedThisCycle,
    monthlyCreditsGrant: row.monthlyCreditsGrant,
    monthlyCreditsBalance: row.monthlyCreditsBalance,
    addOnCreditsBalance: row.addOnCreditsBalance,
    creditsReserved: row.creditsReserved,
    creditsConsumedThisCycle: row.creditsConsumedThisCycle,
    seatCount: row.seatCount,
    spendSoftCapUsd: toNumberOrNull(row.spendSoftCapUsd),
    spendHardCapUsd: toNumberOrNull(row.spendHardCapUsd),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapLedger(row: BillingLedgerRowDb): BillingLedgerRow {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    actorUserId: row.actorUserId,
    feature: row.feature,
    eventType: row.eventType,
    unitType: row.unitType,
    delta: row.delta,
    balanceAfter: row.balanceAfter,
    referenceId: row.referenceId,
    idempotencyKey: row.idempotencyKey,
    operationId: row.operationId,
    operationType: row.operationType,
    activityVisible: row.activityVisible,
    activityTitle: row.activityTitle,
    activitySummary: row.activitySummary,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

function mapSubscription(
  row: BillingSubscriptionRow,
): BillingSubscriptionState {
  return {
    id: row.id,
    teamId: row.teamId,
    provider: row.provider,
    planFamily: row.planFamily,
    status: row.status,
    billingInterval: row.billingInterval,
    currentPeriodStart: row.currentPeriodStart
      ? row.currentPeriodStart.toISOString()
      : null,
    currentPeriodEnd: row.currentPeriodEnd
      ? row.currentPeriodEnd.toISOString()
      : null,
    externalCustomerId: row.externalCustomerId,
    externalSubscriptionId: row.externalSubscriptionId,
    externalSubscriptionItemId: row.externalSubscriptionItemId,
    externalProductId: row.externalProductId,
    billingOrderId: row.billingOrderId,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    metadata: row.metadata ?? {},
    lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapOrder(row: BillingOrderRow): BillingOrderState {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    status: row.status,
    paymentStatus: row.paymentStatus,
    userId: row.userId,
    teamId: row.teamId,
    clientReferenceKey: row.clientReferenceKey,
    planFamily: row.planFamily,
    billingInterval: row.billingInterval,
    quantity: row.quantity,
    unitType: row.unitType,
    unitAmount: row.unitAmount,
    grantedCredits: row.grantedCredits,
    grantedPages: row.grantedPages,
    externalCheckoutId: row.externalCheckoutId,
    externalPaymentId: row.externalPaymentId,
    externalCustomerId: row.externalCustomerId,
    externalSubscriptionId: row.externalSubscriptionId,
    externalProductId: row.externalProductId,
    amountTotal: row.amountTotal,
    currency: row.currency,
    successUrl: row.successUrl,
    cancelUrl: row.cancelUrl,
    metadata: row.metadata ?? {},
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    fulfilledAt: row.fulfilledAt ? row.fulfilledAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    fulfillmentAttemptCount: row.fulfillmentAttemptCount,
    nextRetryAt: row.nextRetryAt ? row.nextRetryAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapWebhookEvent(
  row: BillingWebhookEventRow,
): BillingWebhookEventState {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    teamId: row.teamId,
    externalSubscriptionId: row.externalSubscriptionId,
    status: row.status,
    attemptCount: row.attemptCount,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    payload: row.payload ?? {},
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseNumeric(value: number | null): string | null {
  if (value === null) {
    return null;
  }

  return Number.isFinite(value) ? value.toFixed(4) : null;
}

function parseDate(value: string) {
  return new Date(value);
}

function parseDateOrNull(value: string | null) {
  if (!value) {
    return null;
  }

  return new Date(value);
}

function parseDateOrUndefined(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value);
}

/**
 * Persistence floor of the billing module: the Postgres implementation of the
 * `BillingStore` port.
 *
 * Everything above — ledger primitives applied by `account-service`, the
 * purchase flows, the settle funnel — reaches rows only through the port
 * declared in `store-port.ts`; tests substitute a memory store against the same
 * contract. This file is row mapping and SQL, nothing else: no billing rule
 * lives here, no method decides whether a balance may move. The two behaviors
 * it does own are transactional: `runInTransaction` hands out the client that
 * scopes each locked operation (a fresh connection — it does not nest), and the
 * `FOR UPDATE` readers implement the per-member row locking the services'
 * admission/settle invariants rely on. Ledger appends are inserts of
 * already-built entries; uniqueness of member-scoped idempotency keys is
 * enforced by the table's indexes.
 */
export class PostgresBillingStore implements BillingStore {
  private readonly db;
  constructor(
    private readonly pool: Pool,
    private readonly memberships: Pick<
      BillingStore,
      | "listTeamMemberUserIds"
      | "countTeamMembers"
      | "countPendingTeamInvitations"
    >,
  ) {
    this.db = drizzle(pool, { schema, casing: "snake_case" });
  }

  private pickDb(client?: PoolClient) {
    if (!client) {
      return this.db;
    }

    return drizzle(client as any, {
      schema,
      casing: "snake_case",
    });
  }

  async runInTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAccount(teamId: string, userId: string, client?: PoolClient) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingAccounts)
      .where(
        and(
          eq(billingAccounts.teamId, teamId),
          eq(billingAccounts.userId, userId),
        ),
      )
      .limit(1);

    return row ? mapAccount(row) : null;
  }

  async getAccountForUpdate(
    teamId: string,
    userId: string,
    client: PoolClient,
  ) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingAccounts)
      .where(
        and(
          eq(billingAccounts.teamId, teamId),
          eq(billingAccounts.userId, userId),
        ),
      )
      .limit(1)
      .for("update");

    return row ? mapAccount(row) : null;
  }

  /**
   * All member rows for a team, locked FOR UPDATE — the basis for team-wide
   * operations (plan change, cycle renewal, seat updates) that must apply to
   * every member's allocation.
   */
  async getTeamAccountsForUpdate(teamId: string, client: PoolClient) {
    const rows = await this.pickDb(client)
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.teamId, teamId))
      .for("update");

    return rows.map(mapAccount);
  }

  /**
   * Any one member row for the team — used to read team-level attributes
   * (plan family, cycle window) without a specific member in hand.
   */
  async getAnyTeamAccount(teamId: string, client?: PoolClient) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.teamId, teamId))
      .limit(1);

    return row ? mapAccount(row) : null;
  }

  /** Better Auth organization members — the users who each get an allocation row. */
  async listTeamMemberUserIds(teamId: string, client?: PoolClient) {
    return this.memberships.listTeamMemberUserIds(teamId, client);
  }

  async insertAccount(account: BillingAccountState, client: PoolClient) {
    await this.pickDb(client)
      .insert(billingAccounts)
      .values({
        teamId: account.teamId,
        userId: account.userId,
        planFamily: account.planFamily,
        cycleAnchorAt: parseDate(account.cycleAnchorAt),
        cycleSource: account.cycleSource,
        cycleStartAt: parseDate(account.cycleStartAt),
        cycleEndAt: parseDate(account.cycleEndAt),
        pagesLimit: account.pagesLimit,
        pagesUsed: account.pagesUsed,
        monthlyPagesGrant: account.monthlyPagesGrant,
        monthlyPagesBalance: account.monthlyPagesBalance,
        addOnPagesBalance: account.addOnPagesBalance,
        pagesConsumedThisCycle: account.pagesConsumedThisCycle,
        monthlyCreditsGrant: account.monthlyCreditsGrant,
        monthlyCreditsBalance: account.monthlyCreditsBalance,
        addOnCreditsBalance: account.addOnCreditsBalance,
        creditsReserved: account.creditsReserved,
        creditsConsumedThisCycle: account.creditsConsumedThisCycle,
        seatCount: account.seatCount,
        spendSoftCapUsd: parseNumeric(account.spendSoftCapUsd),
        spendHardCapUsd: parseNumeric(account.spendHardCapUsd),
        createdAt: parseDate(account.createdAt),
        updatedAt: parseDate(account.updatedAt),
      });
  }

  async updateAccount(account: BillingAccountState, client: PoolClient) {
    await this.pickDb(client)
      .update(billingAccounts)
      .set({
        planFamily: account.planFamily,
        cycleAnchorAt: parseDate(account.cycleAnchorAt),
        cycleSource: account.cycleSource,
        cycleStartAt: parseDate(account.cycleStartAt),
        cycleEndAt: parseDate(account.cycleEndAt),
        pagesLimit: account.pagesLimit,
        pagesUsed: account.pagesUsed,
        monthlyPagesGrant: account.monthlyPagesGrant,
        monthlyPagesBalance: account.monthlyPagesBalance,
        addOnPagesBalance: account.addOnPagesBalance,
        pagesConsumedThisCycle: account.pagesConsumedThisCycle,
        monthlyCreditsGrant: account.monthlyCreditsGrant,
        monthlyCreditsBalance: account.monthlyCreditsBalance,
        addOnCreditsBalance: account.addOnCreditsBalance,
        creditsReserved: account.creditsReserved,
        creditsConsumedThisCycle: account.creditsConsumedThisCycle,
        seatCount: account.seatCount,
        spendSoftCapUsd: parseNumeric(account.spendSoftCapUsd),
        spendHardCapUsd: parseNumeric(account.spendHardCapUsd),
        updatedAt: parseDate(account.updatedAt),
      })
      .where(
        and(
          eq(billingAccounts.teamId, account.teamId),
          eq(billingAccounts.userId, account.userId),
        ),
      );
  }

  async appendLedger(entry: BillingLedgerRow, client: PoolClient) {
    await this.pickDb(client)
      .insert(usageLedgers)
      .values({
        id: entry.id,
        teamId: entry.teamId,
        workspaceId: entry.workspaceId,
        actorUserId: entry.actorUserId,
        feature: entry.feature,
        eventType: entry.eventType,
        unitType: entry.unitType,
        delta: entry.delta,
        balanceAfter: entry.balanceAfter,
        referenceId: entry.referenceId,
        idempotencyKey: entry.idempotencyKey,
        operationId: entry.operationId,
        operationType: entry.operationType,
        activityVisible: entry.activityVisible,
        activityTitle: entry.activityTitle,
        activitySummary: entry.activitySummary,
        metadata: entry.metadata ?? {},
        createdAt: parseDate(entry.createdAt),
      });
  }

  async getLedgerByIdempotency(
    teamId: string,
    idempotencyKey: string,
    client?: PoolClient,
  ) {
    const [row] = await this.pickDb(client)
      .select()
      .from(usageLedgers)
      .where(
        and(
          eq(usageLedgers.teamId, teamId),
          eq(usageLedgers.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    return row ? mapLedger(row) : null;
  }

  async listLedger(
    teamId: string,
    limit?: number,
    options?: {
      activityOnly?: boolean;
      actorUserId?: string;
      cursor?: { createdAt: Date; id: string } | null;
    },
    client?: PoolClient,
  ) {
    const conditions = [
      eq(usageLedgers.teamId, teamId),
      options?.activityOnly
        ? eq(usageLedgers.activityVisible, true)
        : undefined,
      // Scope to a single member's lines (non-managers see only their own feed).
      options?.actorUserId
        ? eq(usageLedgers.actorUserId, options.actorUserId)
        : undefined,
      options?.cursor
        ? or(
            lt(usageLedgers.createdAt, options.cursor.createdAt),
            and(
              eq(usageLedgers.createdAt, options.cursor.createdAt),
              lt(usageLedgers.id, options.cursor.id),
            ),
          )
        : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> =>
      Boolean(condition),
    );
    const query = this.pickDb(client)
      .select()
      .from(usageLedgers)
      .where(and(...conditions))
      .orderBy(desc(usageLedgers.createdAt), desc(usageLedgers.id));

    const rows = limit !== undefined ? await query.limit(limit) : await query;

    return rows.map(mapLedger);
  }

  async getOrderById(orderId: string, client?: PoolClient) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingOrders)
      .where(eq(billingOrders.id, orderId))
      .limit(1);

    return row ? mapOrder(row) : null;
  }

  async getOrderByIdForUpdate(orderId: string, client: PoolClient) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingOrders)
      .where(eq(billingOrders.id, orderId))
      .limit(1)
      .for("update");

    return row ? mapOrder(row) : null;
  }

  async getOrderByClientReference(
    userId: string,
    clientReferenceKey: string,
    client?: PoolClient,
  ) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingOrders)
      .where(
        and(
          eq(billingOrders.userId, userId),
          eq(billingOrders.clientReferenceKey, clientReferenceKey),
        ),
      )
      .limit(1);

    return row ? mapOrder(row) : null;
  }

  async getOrderByProviderCheckoutId(
    provider: BillingOrderState["provider"],
    externalCheckoutId: string,
    client?: PoolClient,
  ) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingOrders)
      .where(
        and(
          eq(billingOrders.provider, provider),
          eq(billingOrders.externalCheckoutId, externalCheckoutId),
        ),
      )
      .limit(1);

    return row ? mapOrder(row) : null;
  }

  async insertOrder(order: BillingOrderState, client?: PoolClient) {
    const [row] = await this.pickDb(client)
      .insert(billingOrders)
      .values({
        id: order.id,
        provider: order.provider,
        kind: order.kind,
        status: order.status,
        paymentStatus: order.paymentStatus,
        userId: order.userId,
        teamId: order.teamId,
        clientReferenceKey: order.clientReferenceKey,
        planFamily: order.planFamily,
        billingInterval: order.billingInterval,
        quantity: order.quantity,
        unitType: order.unitType,
        unitAmount: order.unitAmount,
        grantedCredits: order.grantedCredits,
        grantedPages: order.grantedPages,
        externalCheckoutId: order.externalCheckoutId,
        externalPaymentId: order.externalPaymentId,
        externalCustomerId: order.externalCustomerId,
        externalSubscriptionId: order.externalSubscriptionId,
        externalProductId: order.externalProductId,
        amountTotal: order.amountTotal,
        currency: order.currency,
        successUrl: order.successUrl,
        cancelUrl: order.cancelUrl,
        metadata: order.metadata,
        errorCode: order.errorCode,
        errorMessage: order.errorMessage,
        paidAt: parseDateOrUndefined(order.paidAt),
        fulfilledAt: parseDateOrUndefined(order.fulfilledAt),
        expiresAt: parseDateOrUndefined(order.expiresAt),
        fulfillmentAttemptCount: order.fulfillmentAttemptCount,
        nextRetryAt: parseDateOrUndefined(order.nextRetryAt),
        createdAt: parseDate(order.createdAt),
        updatedAt: parseDate(order.updatedAt),
      })
      .returning();

    if (!row) {
      throw new Error("Failed to insert billing order");
    }

    return mapOrder(row);
  }

  async updateOrder(order: BillingOrderState, client?: PoolClient) {
    const [row] = await this.pickDb(client)
      .update(billingOrders)
      .set({
        provider: order.provider,
        kind: order.kind,
        status: order.status,
        paymentStatus: order.paymentStatus,
        userId: order.userId,
        teamId: order.teamId,
        clientReferenceKey: order.clientReferenceKey,
        planFamily: order.planFamily,
        billingInterval: order.billingInterval,
        quantity: order.quantity,
        unitType: order.unitType,
        unitAmount: order.unitAmount,
        grantedCredits: order.grantedCredits,
        grantedPages: order.grantedPages,
        externalCheckoutId: order.externalCheckoutId,
        externalPaymentId: order.externalPaymentId,
        externalCustomerId: order.externalCustomerId,
        externalSubscriptionId: order.externalSubscriptionId,
        externalProductId: order.externalProductId,
        amountTotal: order.amountTotal,
        currency: order.currency,
        successUrl: order.successUrl,
        cancelUrl: order.cancelUrl,
        metadata: order.metadata,
        errorCode: order.errorCode,
        errorMessage: order.errorMessage,
        paidAt: parseDateOrUndefined(order.paidAt),
        fulfilledAt: parseDateOrUndefined(order.fulfilledAt),
        expiresAt: parseDateOrUndefined(order.expiresAt),
        fulfillmentAttemptCount: order.fulfillmentAttemptCount,
        nextRetryAt: parseDateOrUndefined(order.nextRetryAt),
        updatedAt: parseDate(order.updatedAt),
      })
      .where(eq(billingOrders.id, order.id))
      .returning();

    if (!row) {
      throw new Error("Failed to update billing order");
    }

    return mapOrder(row);
  }

  async findOpenSubscriptionOrder(
    input: {
      userId: string;
      teamId: string | null;
      planFamily: BillingOrderState["planFamily"];
      billingInterval: BillingOrderState["billingInterval"];
    },
    client?: PoolClient,
  ) {
    const teamPredicate =
      input.teamId === null
        ? sql`${billingOrders.teamId} is null`
        : eq(billingOrders.teamId, input.teamId);
    const [row] = await this.pickDb(client)
      .select()
      .from(billingOrders)
      .where(
        and(
          eq(billingOrders.kind, "subscription"),
          eq(billingOrders.userId, input.userId),
          teamPredicate,
          sql`${billingOrders.planFamily} = ${input.planFamily}`,
          sql`${billingOrders.billingInterval} = ${input.billingInterval}`,
          sql`${billingOrders.status} in ('pending', 'checkout_created')`,
        ),
      )
      .orderBy(desc(billingOrders.createdAt))
      .limit(1);

    return row ? mapOrder(row) : null;
  }

  async getLatestCustomerOrderByUser(userId: string, client?: PoolClient) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingOrders)
      .where(
        and(
          eq(billingOrders.userId, userId),
          sql`${billingOrders.externalCustomerId} is not null`,
          sql`${billingOrders.status} in ('payment_confirmed', 'fulfilled')`,
        ),
      )
      .orderBy(desc(billingOrders.updatedAt))
      .limit(1);

    return row ? mapOrder(row) : null;
  }

  async listRetryableOrders(input?: { limit?: number }, client?: PoolClient) {
    const safeLimit = Math.min(
      100,
      Math.max(1, Math.floor(input?.limit ?? 25)),
    );
    const rows = await this.pickDb(client)
      .select()
      .from(billingOrders)
      .where(
        and(
          sql`${billingOrders.status} in ('payment_confirmed', 'fulfillment_failed')`,
          or(
            isNull(billingOrders.nextRetryAt),
            lte(billingOrders.nextRetryAt, new Date()),
          ),
        ),
      )
      .orderBy(billingOrders.createdAt)
      .limit(safeLimit);

    return rows.map(mapOrder);
  }

  async countTeamMembers(teamId: string, client?: PoolClient) {
    return this.memberships.countTeamMembers(teamId, client);
  }

  async countPendingTeamInvitations(teamId: string, client?: PoolClient) {
    return this.memberships.countPendingTeamInvitations(teamId, client);
  }

  async getSubscriptionByTeam(teamId: string, client?: PoolClient) {
    const [row] = await this.pickDb(client)
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.teamId, teamId))
      .limit(1);

    return row ? mapSubscription(row) : null;
  }

  async getSubscriptionByProviderSubscription(
    provider: BillingSubscriptionState["provider"],
    externalSubscriptionId: string,
    client?: PoolClient,
  ) {
    const [row] = await this.pickDb(client)
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.provider, provider),
          eq(subscriptions.externalSubscriptionId, externalSubscriptionId),
        ),
      )
      .limit(1);

    return row ? mapSubscription(row) : null;
  }

  async getLatestCustomerSubscriptionByUser(
    userId: string,
    client?: PoolClient,
  ) {
    const [row] = await this.pickDb(client)
      .select({
        subscription: subscriptions,
      })
      .from(subscriptions)
      .innerJoin(
        billingOrders,
        eq(billingOrders.id, subscriptions.billingOrderId),
      )
      .where(
        and(
          eq(billingOrders.userId, userId),
          sql`${subscriptions.externalCustomerId} is not null`,
        ),
      )
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);

    return row ? mapSubscription(row.subscription) : null;
  }

  async upsertSubscription(
    snapshot: TeamSubscriptionSnapshot,
    client: PoolClient,
  ) {
    const now = new Date();

    const [row] = await this.pickDb(client)
      .insert(subscriptions)
      .values({
        id: randomUUID(),
        teamId: snapshot.teamId,
        provider: snapshot.provider,
        planFamily: snapshot.planFamily,
        status: snapshot.status,
        billingInterval: snapshot.billingInterval,
        currentPeriodStart: parseDateOrNull(snapshot.currentPeriodStart),
        currentPeriodEnd: parseDateOrNull(snapshot.currentPeriodEnd),
        externalCustomerId: snapshot.externalCustomerId,
        externalSubscriptionId: snapshot.externalSubscriptionId,
        externalSubscriptionItemId: snapshot.externalSubscriptionItemId ?? null,
        externalProductId: snapshot.externalProductId,
        billingOrderId: snapshot.billingOrderId ?? null,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        metadata: snapshot.metadata,
        lastEventAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [subscriptions.teamId],
        set: {
          provider: snapshot.provider,
          planFamily: snapshot.planFamily,
          status: snapshot.status,
          billingInterval: snapshot.billingInterval,
          currentPeriodStart: parseDateOrNull(snapshot.currentPeriodStart),
          currentPeriodEnd: parseDateOrNull(snapshot.currentPeriodEnd),
          externalCustomerId:
            snapshot.externalCustomerId ??
            sql`${subscriptions.externalCustomerId}`,
          externalSubscriptionId: snapshot.externalSubscriptionId,
          externalSubscriptionItemId:
            snapshot.externalSubscriptionItemId ?? null,
          externalProductId: snapshot.externalProductId,
          billingOrderId: snapshot.billingOrderId ?? null,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
          metadata: snapshot.metadata,
          lastEventAt: now,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) {
      throw new Error("Failed to upsert subscription");
    }

    return mapSubscription(row);
  }

  async getWebhookEventByProviderEventId(
    provider: BillingWebhookEventState["provider"],
    providerEventId: string,
    client?: PoolClient,
  ) {
    const [row] = await this.pickDb(client)
      .select()
      .from(billingWebhookEvents)
      .where(
        and(
          eq(billingWebhookEvents.provider, provider),
          eq(billingWebhookEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1);

    return row ? mapWebhookEvent(row) : null;
  }

  async insertWebhookEvent(
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
  ) {
    const now = new Date();

    const [row] = await this.pickDb(client)
      .insert(billingWebhookEvents)
      .values({
        id: randomUUID(),
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        teamId: input.teamId,
        externalSubscriptionId: input.externalSubscriptionId,
        status: "received",
        attemptCount: 1,
        receivedAt: now,
        processedAt: null,
        errorCode: null,
        errorMessage: null,
        payload: input.payload,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          billingWebhookEvents.provider,
          billingWebhookEvents.providerEventId,
        ],
      })
      .returning();

    if (!row) {
      const [existing] = await this.pickDb(client)
        .select()
        .from(billingWebhookEvents)
        .where(
          and(
            eq(billingWebhookEvents.provider, input.provider),
            eq(billingWebhookEvents.providerEventId, input.providerEventId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new Error("Failed to insert webhook event");
      }

      return mapWebhookEvent(existing);
    }

    return mapWebhookEvent(row);
  }

  async incrementWebhookEventAttempt(
    webhookEventId: string,
    input: {
      eventType: string;
      teamId: string | null;
      externalSubscriptionId: string | null;
      payload: Record<string, unknown>;
      metadata: Record<string, unknown>;
    },
    client?: PoolClient,
  ) {
    const [existing] = await this.pickDb(client)
      .select()
      .from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.id, webhookEventId))
      .limit(1);

    if (!existing) {
      throw new Error("Webhook event not found for retry update");
    }

    const now = new Date();
    const nextStatus =
      existing.status === "processed" ? "processed" : "received";
    const preserveAuditPayload = existing.status === "processed";
    const [row] = await this.pickDb(client)
      .update(billingWebhookEvents)
      .set({
        eventType: preserveAuditPayload ? existing.eventType : input.eventType,
        teamId: preserveAuditPayload ? existing.teamId : input.teamId,
        externalSubscriptionId: preserveAuditPayload
          ? existing.externalSubscriptionId
          : input.externalSubscriptionId,
        status: nextStatus,
        attemptCount: existing.attemptCount + 1,
        receivedAt: now,
        processedAt: nextStatus === "processed" ? existing.processedAt : null,
        errorCode: nextStatus === "processed" ? existing.errorCode : null,
        errorMessage: nextStatus === "processed" ? existing.errorMessage : null,
        payload: preserveAuditPayload ? existing.payload : input.payload,
        metadata: preserveAuditPayload ? existing.metadata : input.metadata,
        updatedAt: now,
      })
      .where(eq(billingWebhookEvents.id, webhookEventId))
      .returning();

    if (!row) {
      throw new Error("Failed to increment webhook event attempt");
    }

    return mapWebhookEvent(row);
  }

  async updateWebhookEventState(
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
  ) {
    const [existing] = await this.pickDb(client)
      .select()
      .from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.id, webhookEventId))
      .limit(1);

    if (!existing) {
      throw new Error("Webhook event not found for status update");
    }

    const now = new Date();
    const [row] = await this.pickDb(client)
      .update(billingWebhookEvents)
      .set({
        status: input.status,
        teamId: input.teamId ?? existing.teamId,
        externalSubscriptionId:
          input.externalSubscriptionId ?? existing.externalSubscriptionId,
        processedAt:
          input.processedAt === undefined
            ? existing.processedAt
            : parseDateOrNull(input.processedAt),
        errorCode:
          input.errorCode === undefined ? existing.errorCode : input.errorCode,
        errorMessage:
          input.errorMessage === undefined
            ? existing.errorMessage
            : input.errorMessage,
        metadata: input.metadata ?? existing.metadata,
        updatedAt: now,
      })
      .where(eq(billingWebhookEvents.id, webhookEventId))
      .returning();

    if (!row) {
      throw new Error("Failed to update webhook event status");
    }

    return mapWebhookEvent(row);
  }

  async listAccountSubscriptionStates(
    client?: PoolClient,
  ): ReturnType<BillingStore["listAccountSubscriptionStates"]> {
    const rows = await this.pickDb(client)
      .select({
        teamId: billingAccounts.teamId,
        accountPlanFamily: billingAccounts.planFamily,
        subscriptionPlanFamily: subscriptions.planFamily,
        subscriptionStatus: subscriptions.status,
        externalSubscriptionId: subscriptions.externalSubscriptionId,
      })
      .from(billingAccounts)
      .leftJoin(
        subscriptions,
        eq(subscriptions.teamId, billingAccounts.teamId),
      );

    return rows.map((row) => ({
      teamId: row.teamId,
      accountPlanFamily: row.accountPlanFamily,
      subscriptionPlanFamily: row.subscriptionPlanFamily ?? null,
      subscriptionStatus: row.subscriptionStatus ?? null,
      externalSubscriptionId: row.externalSubscriptionId ?? null,
    }));
  }
}
