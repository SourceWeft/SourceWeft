/**
 * Persistence for inbound connector webhook events — the provider-deduplicated
 * envelopes that a webhook delivery is recorded as before it is processed.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { connectorWebhookEvents, db } from "@sourceweft/db";
import { ConnectorError } from "../errors";
import { mapWebhookEvent } from "../mappers";
import type { ConnectorWebhookEventStatus } from "../types";

export async function insertWebhookEventRecord(input: {
  teamId?: string | null;
  workspaceId?: string | null;
  connectorId?: string | null;
  connectorType: string;
  providerEventId: string;
  eventType: string;
  status: ConnectorWebhookEventStatus;
  objectId?: string | null;
  objectType?: string | null;
  payloadMetadataJson?: Record<string, unknown>;
}) {
  const existing = await findWebhookEventByProviderEventId({
    connectorType: input.connectorType,
    providerEventId: input.providerEventId,
  });
  if (existing) {
    return existing;
  }

  const [row] = await db
    .insert(connectorWebhookEvents)
    .values({
      id: randomUUID(),
      teamId: input.teamId ?? null,
      workspaceId: input.workspaceId ?? null,
      connectorId: input.connectorId ?? null,
      connectorType: input.connectorType,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      status: input.status,
      objectId: input.objectId ?? null,
      objectType: input.objectType ?? null,
      payloadMetadataJson: input.payloadMetadataJson ?? {},
    })
    .returning();

  if (!row) {
    throw new ConnectorError(
      500,
      "CONNECTOR_WEBHOOK_EVENT_INSERT_FAILED",
      "Failed to insert connector webhook event",
      {
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
      },
    );
  }

  return mapWebhookEvent(row);
}

export async function findWebhookEventByProviderEventId(input: {
  connectorType: string;
  providerEventId: string;
}) {
  const [row] = await db
    .select()
    .from(connectorWebhookEvents)
    .where(
      and(
        eq(connectorWebhookEvents.connectorType, input.connectorType),
        eq(connectorWebhookEvents.providerEventId, input.providerEventId),
      ),
    )
    .limit(1);

  return row ? mapWebhookEvent(row) : null;
}

export async function listWebhookEventRecords(input: {
  teamId: string;
  workspaceId: string;
  connectorType?: string;
  connectorId?: string;
}) {
  const conditions = [
    eq(connectorWebhookEvents.teamId, input.teamId),
    eq(connectorWebhookEvents.workspaceId, input.workspaceId),
  ];
  if (input.connectorType) {
    conditions.push(
      eq(connectorWebhookEvents.connectorType, input.connectorType),
    );
  }
  if (input.connectorId) {
    conditions.push(eq(connectorWebhookEvents.connectorId, input.connectorId));
  }

  const rows = await db
    .select()
    .from(connectorWebhookEvents)
    .where(and(...conditions))
    .orderBy(desc(connectorWebhookEvents.createdAt))
    .limit(50);

  return rows.map(mapWebhookEvent);
}

export async function updateWebhookEventRecord(input: {
  webhookEventId: string;
  status?: ConnectorWebhookEventStatus;
  attemptsDelta?: number;
  teamId?: string | null;
  workspaceId?: string | null;
  connectorId?: string | null;
  syncRunId?: string | null;
  payloadMetadataJson?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  processedAt?: Date | null;
}) {
  const updates: Partial<typeof connectorWebhookEvents.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.status !== undefined) updates.status = input.status;
  if (input.teamId !== undefined) updates.teamId = input.teamId;
  if (input.workspaceId !== undefined) updates.workspaceId = input.workspaceId;
  if (input.connectorId !== undefined) updates.connectorId = input.connectorId;
  if (input.syncRunId !== undefined) updates.syncRunId = input.syncRunId;
  if (input.payloadMetadataJson !== undefined) {
    updates.payloadMetadataJson = input.payloadMetadataJson;
  }
  if (input.errorCode !== undefined) updates.errorCode = input.errorCode;
  if (input.errorMessage !== undefined)
    updates.errorMessage = input.errorMessage;
  if (input.processedAt !== undefined) updates.processedAt = input.processedAt;

  const setValues: Record<string, unknown> = { ...updates };
  if (input.attemptsDelta !== undefined) {
    setValues.attempts = sql`${connectorWebhookEvents.attempts} + ${input.attemptsDelta}`;
  }

  const [row] = await db
    .update(connectorWebhookEvents)
    .set(setValues)
    .where(eq(connectorWebhookEvents.id, input.webhookEventId))
    .returning();

  return row ? mapWebhookEvent(row) : null;
}
