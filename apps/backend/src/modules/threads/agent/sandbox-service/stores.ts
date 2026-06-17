import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type {
  ExistingSandboxOperation,
  SandboxBridgeOperationType,
  SandboxOperationStatus,
  SandboxOperationStore,
  SandboxOperationType,
  SandboxProviderId,
  SandboxRecord,
  SandboxRuntimeContext,
  SandboxStore,
} from "@sourceweft/builtin-tool-sandbox";
import { agentSandboxes, agentSandboxOperations, db } from "@sourceweft/db";

export class DrizzleSandboxStore implements SandboxStore {
  async findLatestActiveThreadSandbox(input: {
    provider: SandboxProviderId;
    context: SandboxRuntimeContext;
  }): Promise<SandboxRecord | null> {
    const row = await db.query.agentSandboxes.findFirst({
      where: and(
        eq(agentSandboxes.provider, input.provider),
        eq(agentSandboxes.teamId, input.context.teamId),
        eq(agentSandboxes.workspaceId, input.context.workspaceId),
        eq(agentSandboxes.threadId, input.context.threadId),
        inArray(agentSandboxes.status, ["creating", "ready"]),
      ),
      orderBy: [desc(agentSandboxes.updatedAt)],
    });
    return row ?? null;
  }

  async markCreatingSandboxError(input: {
    sandboxId: string;
    expectedUpdatedAt?: Date;
  }) {
    const where = input.expectedUpdatedAt
      ? and(
          eq(agentSandboxes.id, input.sandboxId),
          eq(agentSandboxes.status, "creating"),
          eq(agentSandboxes.updatedAt, input.expectedUpdatedAt),
        )
      : eq(agentSandboxes.id, input.sandboxId);
    const updated = await db.update(agentSandboxes)
      .set({ status: "error", updatedAt: new Date() })
      .where(where)
      .returning({ id: agentSandboxes.id });
    return updated.length > 0;
  }

  async insertCreatingSandbox(input: {
    sandboxId: string;
    provider: SandboxProviderId;
    providerSandboxId: string;
    context: SandboxRuntimeContext;
    expiresAt: Date;
  }) {
    const inserted = await db.insert(agentSandboxes).values({
      id: input.sandboxId,
      provider: input.provider,
      providerSandboxId: input.providerSandboxId,
      teamId: input.context.teamId,
      workspaceId: input.context.workspaceId,
      threadId: input.context.threadId,
      userId: input.context.userId,
      status: "creating",
      networkPolicy: "default",
      lastUsedAt: new Date(),
      expiresAt: input.expiresAt,
    }).onConflictDoNothing().returning({ id: agentSandboxes.id });
    return inserted.length > 0;
  }

  async markSandboxReady(input: {
    sandboxId: string;
    providerSandboxId: string;
    expiresAt: Date;
  }) {
    await db.update(agentSandboxes)
      .set({
        providerSandboxId: input.providerSandboxId,
        status: "ready",
        lastUsedAt: new Date(),
        expiresAt: input.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(agentSandboxes.id, input.sandboxId));
  }

  async markSandboxExpired(input: { sandboxId: string }) {
    await db.update(agentSandboxes)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(agentSandboxes.id, input.sandboxId));
  }

  async releaseReadyThreadSandboxLease(input: {
    provider: SandboxProviderId;
    context: SandboxRuntimeContext;
    expiresAt: Date;
    reason: string;
  }) {
    const now = new Date();
    const updated = await db.update(agentSandboxes)
      .set({
        expiresAt: input.expiresAt,
        metadataJson: {
          releaseReason: input.reason,
          releasedAt: now.toISOString(),
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(agentSandboxes.provider, input.provider),
          eq(agentSandboxes.teamId, input.context.teamId),
          eq(agentSandboxes.workspaceId, input.context.workspaceId),
          eq(agentSandboxes.threadId, input.context.threadId),
          eq(agentSandboxes.status, "ready"),
          or(
            sql`${agentSandboxes.expiresAt} is null`,
            gte(agentSandboxes.expiresAt, input.expiresAt),
          ),
        ),
      )
      .returning({ id: agentSandboxes.id });
    return updated.length;
  }

  async touchSandbox(input: { sandboxId: string; expiresAt: Date }) {
    const now = new Date();
    await db.update(agentSandboxes)
      .set({
        lastUsedAt: now,
        expiresAt: input.expiresAt,
        updatedAt: now,
      })
      .where(eq(agentSandboxes.id, input.sandboxId));
  }
}

export class DrizzleSandboxOperationStore implements SandboxOperationStore {
  async findLatestToolOperation(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
    statuses: Array<"running" | "succeeded" | "failed">;
  }): Promise<ExistingSandboxOperation | null> {
    const row = await db.query.agentSandboxOperations.findFirst({
      where: and(
        eq(agentSandboxOperations.teamId, input.context.teamId),
        eq(agentSandboxOperations.workspaceId, input.context.workspaceId),
        eq(agentSandboxOperations.threadId, input.context.threadId),
        eq(agentSandboxOperations.messageId, input.context.messageId),
        eq(agentSandboxOperations.operationType, input.operationType),
        eq(agentSandboxOperations.toolCallId, input.toolCallId),
        inArray(agentSandboxOperations.status, input.statuses),
      ),
      orderBy: [desc(agentSandboxOperations.createdAt)],
    });
    return row
      ? {
          id: row.id,
          createdAt: row.createdAt,
          messageId: row.messageId ?? undefined,
          status: row.status as "running" | "succeeded" | "failed",
          requestJsonRedacted: row.requestJsonRedacted,
          resultJsonRedacted: row.resultJsonRedacted,
        }
      : null;
  }

  async insertRunningToolOperation(input: {
    operationId: string;
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
    request: Record<string, unknown>;
  }) {
    const inserted = await db.insert(agentSandboxOperations).values({
      id: input.operationId,
      operationType: input.operationType,
      teamId: input.context.teamId,
      workspaceId: input.context.workspaceId,
      threadId: input.context.threadId,
      messageId: input.context.messageId,
      toolCallId: input.toolCallId,
      userId: input.context.userId,
      status: "running",
      requestJsonRedacted: input.request,
      resultJsonRedacted: {},
    }).onConflictDoNothing().returning({ id: agentSandboxOperations.id });
    return inserted.length > 0;
  }

  async findLatestActiveToolOperation(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
  }) {
    return this.findLatestToolOperation({
      ...input,
      statuses: ["running", "succeeded"],
    });
  }

  async markStaleRunningToolOperationFailed(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
    staleBefore: Date;
    result: Record<string, unknown>;
  }) {
    const updated = await db.update(agentSandboxOperations)
      .set({
        status: "failed",
        resultJsonRedacted: input.result,
      })
      .where(
        and(
          eq(agentSandboxOperations.teamId, input.context.teamId),
          eq(agentSandboxOperations.workspaceId, input.context.workspaceId),
          eq(agentSandboxOperations.threadId, input.context.threadId),
          eq(agentSandboxOperations.messageId, input.context.messageId),
          eq(agentSandboxOperations.operationType, input.operationType),
          eq(agentSandboxOperations.toolCallId, input.toolCallId),
          eq(agentSandboxOperations.status, "running"),
          lte(agentSandboxOperations.createdAt, input.staleBefore),
        ),
      )
      .returning({ id: agentSandboxOperations.id });
    return updated.length > 0;
  }

  async completeToolOperation(input: {
    operationId: string;
    sandboxId?: string | null;
    status: "succeeded" | "failed";
    result?: Record<string, unknown>;
    durationMs?: number;
  }) {
    await db.update(agentSandboxOperations)
      .set({
        sandboxId: input.sandboxId ?? null,
        status: input.status,
        resultJsonRedacted: input.result ?? {},
        durationMs: input.durationMs,
      })
      .where(eq(agentSandboxOperations.id, input.operationId));
  }

  async recordOperation(input: {
    operationId: string;
    context: SandboxRuntimeContext;
    sandboxId?: string | null;
    operationType: SandboxOperationType;
    status: SandboxOperationStatus;
    toolCallId?: string | null;
    request?: Record<string, unknown>;
    result?: Record<string, unknown>;
    durationMs?: number;
  }) {
    await db.insert(agentSandboxOperations).values({
      id: input.operationId || randomUUID(),
      sandboxId: input.sandboxId ?? null,
      operationType: input.operationType,
      teamId: input.context.teamId,
      workspaceId: input.context.workspaceId,
      threadId: input.context.threadId,
      messageId: input.context.messageId,
      toolCallId: input.toolCallId ?? null,
      userId: input.context.userId,
      status: input.status,
      requestJsonRedacted: input.request ?? {},
      resultJsonRedacted: input.result ?? {},
      durationMs: input.durationMs,
    });
  }

  async findSucceededOperationByToolCall(input: {
    context: SandboxRuntimeContext;
    operationType: SandboxBridgeOperationType;
    toolCallId: string;
  }) {
    const existing = await db.query.agentSandboxOperations.findFirst({
      where: and(
        eq(agentSandboxOperations.teamId, input.context.teamId),
        eq(agentSandboxOperations.workspaceId, input.context.workspaceId),
        eq(agentSandboxOperations.threadId, input.context.threadId),
        eq(agentSandboxOperations.messageId, input.context.messageId),
        eq(agentSandboxOperations.operationType, input.operationType),
        eq(agentSandboxOperations.toolCallId, input.toolCallId),
        eq(agentSandboxOperations.status, "succeeded"),
      ),
      orderBy: [desc(agentSandboxOperations.createdAt)],
    });
    return existing
      ? { result: existing.resultJsonRedacted }
      : null;
  }
}
