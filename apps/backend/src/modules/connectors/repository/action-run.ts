/**
 * Persistence for connector action runs — the idempotency-keyed records of an
 * agent-initiated write against a connector, from proposal through execution.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { connectorActionRuns, db } from "@sourceweft/db";
import { ConnectorError } from "../errors";
import { mapActionRun } from "../mappers";
import type {
  ConnectorActionRiskLevel,
  ConnectorActionRunStatus,
} from "../types";

export async function createActionRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: string;
  actionType: string;
  agentToolName?: string | null;
  riskLevel: ConnectorActionRiskLevel;
  status: ConnectorActionRunStatus;
  requestJson: Record<string, unknown>;
  requestPreview: string;
  idempotencyKey: string;
}) {
  const [existing] = await db
    .select()
    .from(connectorActionRuns)
    .where(
      and(
        eq(connectorActionRuns.workspaceId, input.workspaceId),
        eq(connectorActionRuns.connectorId, input.connectorId),
        eq(connectorActionRuns.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    return mapActionRun(existing);
  }

  const [row] = await db
    .insert(connectorActionRuns)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      connectorType: input.connectorType,
      actionType: input.actionType,
      agentToolName: input.agentToolName ?? null,
      riskLevel: input.riskLevel,
      status: input.status,
      requestJson: input.requestJson,
      requestPreview: input.requestPreview,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();

  if (!row) {
    throw new ConnectorError(
      500,
      "CONNECTOR_ACTION_RUN_CREATE_FAILED",
      "Failed to create connector action run",
      {
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        actionType: input.actionType,
      },
    );
  }

  return mapActionRun(row);
}

export async function findActionRunRecordById(input: {
  teamId: string;
  workspaceId: string;
  actionRunId: string;
}) {
  const [row] = await db
    .select()
    .from(connectorActionRuns)
    .where(
      and(
        eq(connectorActionRuns.id, input.actionRunId),
        eq(connectorActionRuns.teamId, input.teamId),
        eq(connectorActionRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapActionRun(row) : null;
}

export async function findActionRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  actionRunId?: string;
  idempotencyKey?: string;
}) {
  const identityCondition = input.actionRunId
    ? eq(connectorActionRuns.id, input.actionRunId)
    : input.idempotencyKey
      ? eq(connectorActionRuns.idempotencyKey, input.idempotencyKey)
      : null;
  if (!identityCondition) {
    return null;
  }

  const [row] = await db
    .select()
    .from(connectorActionRuns)
    .where(
      and(
        identityCondition,
        eq(connectorActionRuns.teamId, input.teamId),
        eq(connectorActionRuns.workspaceId, input.workspaceId),
        eq(connectorActionRuns.connectorId, input.connectorId),
      ),
    )
    .limit(1);

  return row ? mapActionRun(row) : null;
}

export async function listActionRunRecords(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
}) {
  const rows = await db
    .select()
    .from(connectorActionRuns)
    .where(
      and(
        eq(connectorActionRuns.teamId, input.teamId),
        eq(connectorActionRuns.workspaceId, input.workspaceId),
        eq(connectorActionRuns.connectorId, input.connectorId),
      ),
    )
    .orderBy(desc(connectorActionRuns.createdAt))
    .limit(50);

  return rows.map(mapActionRun);
}

export async function updateActionRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  actionRunId: string;
  status?: ConnectorActionRunStatus;
  resultJson?: Record<string, unknown>;
  externalId?: string | null;
  approvedBy?: string | null;
  executedBy?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestJson?: Record<string, unknown>;
  requestPreview?: string;
  agentToolName?: string | null;
}) {
  const updates: Partial<typeof connectorActionRuns.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.status !== undefined) updates.status = input.status;
  if (input.resultJson !== undefined) updates.resultJson = input.resultJson;
  if (input.externalId !== undefined) updates.externalId = input.externalId;
  if (input.approvedBy !== undefined) updates.approvedBy = input.approvedBy;
  if (input.executedBy !== undefined) updates.executedBy = input.executedBy;
  if (input.errorCode !== undefined) updates.errorCode = input.errorCode;
  if (input.errorMessage !== undefined)
    updates.errorMessage = input.errorMessage;
  if (input.requestJson !== undefined) updates.requestJson = input.requestJson;
  if (input.requestPreview !== undefined)
    updates.requestPreview = input.requestPreview;
  if (input.agentToolName !== undefined)
    updates.agentToolName = input.agentToolName;

  const [row] = await db
    .update(connectorActionRuns)
    .set(updates)
    .where(
      and(
        eq(connectorActionRuns.id, input.actionRunId),
        eq(connectorActionRuns.teamId, input.teamId),
        eq(connectorActionRuns.workspaceId, input.workspaceId),
        eq(connectorActionRuns.connectorId, input.connectorId),
      ),
    )
    .returning();

  return row ? mapActionRun(row) : null;
}
