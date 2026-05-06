import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, database } from "../../shared/database";
import * as schema from "../../shared/db/schema";
import {
  billingWebhookEvents,
  billingAccounts,
  subscriptions,
  usageLedgers,
} from "../../shared/db/schema";
import type {
  BillingAccountState,
  BillingLedgerRow,
  BillingSubscriptionState,
  BillingWebhookEventState,
  BillingWebhookStatus,
  TeamSubscriptionSnapshot,
} from "./types";
import type { BillingStore } from "./store-port";

type BillingAccountRow = typeof billingAccounts.$inferSelect;
type BillingLedgerRowDb = typeof usageLedgers.$inferSelect;
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
    planFamily: row.planFamily,
    cycleAnchorDay: row.cycleAnchorDay,
    cycleStartAt: row.cycleStartAt.toISOString(),
    cycleEndAt: row.cycleEndAt.toISOString(),
    pagesLimit: row.pagesLimit,
    pagesUsed: row.pagesUsed,
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
    currentPeriodStart: row.currentPeriodStart
      ? row.currentPeriodStart.toISOString()
      : null,
    currentPeriodEnd: row.currentPeriodEnd
      ? row.currentPeriodEnd.toISOString()
      : null,
    externalCustomerId: row.externalCustomerId,
    externalSubscriptionId: row.externalSubscriptionId,
    externalProductId: row.externalProductId,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    metadata: row.metadata ?? {},
    lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
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

function pickDb(client?: PoolClient) {
  if (!client) {
    return db;
  }

  return drizzle(client as any, {
    schema,
    casing: "snake_case",
  });
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

export class PostgresBillingStore implements BillingStore {
  async runInTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await database.connect();

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

  async getAccount(teamId: string, client?: PoolClient) {
    const [row] = await pickDb(client)
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.teamId, teamId))
      .limit(1);

    return row ? mapAccount(row) : null;
  }

  async getAccountForUpdate(teamId: string, client: PoolClient) {
    const [row] = await pickDb(client)
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.teamId, teamId))
      .limit(1)
      .for("update");

    return row ? mapAccount(row) : null;
  }

  async insertAccount(account: BillingAccountState, client: PoolClient) {
    await pickDb(client)
      .insert(billingAccounts)
      .values({
        teamId: account.teamId,
        planFamily: account.planFamily,
        cycleAnchorDay: account.cycleAnchorDay,
        cycleStartAt: parseDate(account.cycleStartAt),
        cycleEndAt: parseDate(account.cycleEndAt),
        pagesLimit: account.pagesLimit,
        pagesUsed: account.pagesUsed,
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
    await pickDb(client)
      .update(billingAccounts)
      .set({
        planFamily: account.planFamily,
        cycleAnchorDay: account.cycleAnchorDay,
        cycleStartAt: parseDate(account.cycleStartAt),
        cycleEndAt: parseDate(account.cycleEndAt),
        pagesLimit: account.pagesLimit,
        pagesUsed: account.pagesUsed,
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
      .where(eq(billingAccounts.teamId, account.teamId));
  }

  async appendLedger(entry: BillingLedgerRow, client: PoolClient) {
    await pickDb(client)
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
        metadata: entry.metadata ?? {},
        createdAt: parseDate(entry.createdAt),
      });
  }

  async getLedgerByIdempotency(
    teamId: string,
    idempotencyKey: string,
    client?: PoolClient,
  ) {
    const [row] = await pickDb(client)
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

  async listLedger(teamId: string, limit?: number, client?: PoolClient) {
    const query = pickDb(client)
      .select()
      .from(usageLedgers)
      .where(eq(usageLedgers.teamId, teamId))
      .orderBy(desc(usageLedgers.createdAt));

    const rows = limit !== undefined ? await query.limit(limit) : await query;

    return rows.map(mapLedger);
  }

  async countTeamMembers(teamId: string, client?: PoolClient) {
    const result = await pickDb(client).execute<{ count: string }>(sql`
      select count(*)::text as count
      from member
      where "organizationId" = ${teamId}
    `);

    const rawCount = result.rows?.[0]?.count;
    const count = rawCount ? Number(rawCount) : 0;
    return Number.isFinite(count) ? count : 0;
  }

  async getSubscriptionByTeam(teamId: string, client?: PoolClient) {
    const [row] = await pickDb(client)
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.teamId, teamId))
      .limit(1);

    return row ? mapSubscription(row) : null;
  }

  async upsertSubscription(
    snapshot: TeamSubscriptionSnapshot,
    client: PoolClient,
  ) {
    const now = new Date();

    const [row] = await pickDb(client)
      .insert(subscriptions)
      .values({
        id: randomUUID(),
        teamId: snapshot.teamId,
        provider: snapshot.provider,
        planFamily: snapshot.planFamily,
        status: snapshot.status,
        currentPeriodStart: parseDateOrNull(snapshot.currentPeriodStart),
        currentPeriodEnd: parseDateOrNull(snapshot.currentPeriodEnd),
        externalCustomerId: snapshot.externalCustomerId,
        externalSubscriptionId: snapshot.externalSubscriptionId,
        externalProductId: snapshot.externalProductId,
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
          currentPeriodStart: parseDateOrNull(snapshot.currentPeriodStart),
          currentPeriodEnd: parseDateOrNull(snapshot.currentPeriodEnd),
          externalCustomerId: snapshot.externalCustomerId,
          externalSubscriptionId: snapshot.externalSubscriptionId,
          externalProductId: snapshot.externalProductId,
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
    const [row] = await pickDb(client)
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

    const [row] = await pickDb(client)
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
      const [existing] = await pickDb(client)
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
    const [existing] = await pickDb(client)
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
    const [row] = await pickDb(client)
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
    const [existing] = await pickDb(client)
      .select()
      .from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.id, webhookEventId))
      .limit(1);

    if (!existing) {
      throw new Error("Webhook event not found for status update");
    }

    const now = new Date();
    const [row] = await pickDb(client)
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

  async listAccountSubscriptionStates(client?: PoolClient) {
    const rows = await pickDb(client)
      .select({
        teamId: billingAccounts.teamId,
        accountPlanFamily: billingAccounts.planFamily,
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
      subscriptionStatus: row.subscriptionStatus ?? null,
      externalSubscriptionId: row.externalSubscriptionId ?? null,
    }));
  }
}

export const billingStore = new PostgresBillingStore();
