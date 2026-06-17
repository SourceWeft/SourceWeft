import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, opsAlerts } from "@sourceweft/db";
import type { OpsAlertState } from "./types";

type OpsAlertRow = typeof opsAlerts.$inferSelect;

function mapAlert(row: OpsAlertRow): OpsAlertState {
  return {
    id: row.id,
    alertKey: row.alertKey,
    level: row.level,
    status: row.status,
    source: row.source,
    title: row.title,
    message: row.message,
    teamId: row.teamId,
    triggerCount: row.triggerCount,
    firstTriggeredAt: row.firstTriggeredAt.toISOString(),
    lastTriggeredAt: row.lastTriggeredAt.toISOString(),
    lastNotifiedAt: row.lastNotifiedAt
      ? row.lastNotifiedAt.toISOString()
      : null,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseDate(value: string) {
  return new Date(value);
}

export class OpsAlertStore {
  async getByAlertKey(alertKey: string) {
    const [row] = await db
      .select()
      .from(opsAlerts)
      .where(eq(opsAlerts.alertKey, alertKey))
      .limit(1);

    return row ? mapAlert(row) : null;
  }

  async create(input: {
    alertKey: string;
    level: OpsAlertState["level"];
    source: string;
    title: string;
    message: string;
    teamId: string | null;
    metadata: Record<string, unknown>;
  }) {
    const now = new Date();

    const [row] = await db
      .insert(opsAlerts)
      .values({
        id: randomUUID(),
        alertKey: input.alertKey,
        level: input.level,
        status: "open",
        source: input.source,
        title: input.title,
        message: input.message,
        teamId: input.teamId,
        triggerCount: 1,
        firstTriggeredAt: now,
        lastTriggeredAt: now,
        lastNotifiedAt: null,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) {
      throw new Error("Failed to create ops alert");
    }

    return mapAlert(row);
  }

  async touch(input: {
    id: string;
    level: OpsAlertState["level"];
    source: string;
    title: string;
    message: string;
    teamId: string | null;
    metadata: Record<string, unknown>;
  }) {
    const [existing] = await db
      .select()
      .from(opsAlerts)
      .where(eq(opsAlerts.id, input.id))
      .limit(1);

    if (!existing) {
      throw new Error("Ops alert not found");
    }

    const now = new Date();
    const [row] = await db
      .update(opsAlerts)
      .set({
        level: input.level,
        status: "open",
        source: input.source,
        title: input.title,
        message: input.message,
        teamId: input.teamId,
        triggerCount: existing.triggerCount + 1,
        lastTriggeredAt: now,
        metadata: input.metadata,
        updatedAt: now,
      })
      .where(eq(opsAlerts.id, input.id))
      .returning();

    if (!row) {
      throw new Error("Failed to update ops alert");
    }

    return mapAlert(row);
  }

  async markNotified(id: string, timestampIso: string) {
    const [existing] = await db
      .select()
      .from(opsAlerts)
      .where(eq(opsAlerts.id, id))
      .limit(1);

    if (!existing) {
      throw new Error("Ops alert not found for notification update");
    }

    const [row] = await db
      .update(opsAlerts)
      .set({
        lastNotifiedAt: parseDate(timestampIso),
        updatedAt: new Date(),
      })
      .where(eq(opsAlerts.id, id))
      .returning();

    if (!row) {
      throw new Error("Failed to mark ops alert notification timestamp");
    }

    return mapAlert(row);
  }

  async resolve(alertKey: string) {
    const [existing] = await db
      .select()
      .from(opsAlerts)
      .where(eq(opsAlerts.alertKey, alertKey))
      .limit(1);

    if (!existing) {
      return null;
    }

    const [row] = await db
      .update(opsAlerts)
      .set({
        status: "resolved",
        updatedAt: new Date(),
      })
      .where(eq(opsAlerts.alertKey, alertKey))
      .returning();

    return row ? mapAlert(row) : null;
  }
}

export const opsAlertStore = new OpsAlertStore();

