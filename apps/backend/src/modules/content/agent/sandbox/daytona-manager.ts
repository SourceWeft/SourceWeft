import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../../shared/database";
import { config } from "../../../../shared/config";
import { agentSandboxOperations, agentSandboxes } from "../../../../shared/db/schema";
import { DAYTONA_PROVIDER, type SandboxRef, type SandboxRuntimeContext } from "./types";
import { DaytonaAdapter } from "./daytona-adapter";

function sandboxExpiresAt() {
  return new Date(Date.now() + config.sandbox.ttlSeconds * 1000);
}

const SANDBOX_CREATING_STALE_MS = 2 * 60 * 1000;

type BridgeOperationType = "prepare" | "execute" | "collect";

type BeginToolOperationResult =
  | { kind: "claimed"; operationId: string }
  | { kind: "replay"; result: Record<string, unknown> };

type ExistingToolOperation = {
  status: "running" | "succeeded" | "failed";
  requestJsonRedacted: Record<string, unknown>;
  resultJsonRedacted: Record<string, unknown>;
};

export function stableSandboxRequestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSandboxRequestJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSandboxRequestJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameSandboxRequest(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return stableSandboxRequestJson(left) === stableSandboxRequestJson(right);
}

function failedRetryMessage(input: {
  operationType: BridgeOperationType;
  result: Record<string, unknown>;
}) {
  const error = typeof input.result.error === "string" ? ` Last failure: ${input.result.error}` : "";
  return `SANDBOX_OPERATION_FAILED_RETRY_REQUIRED: sandbox ${input.operationType} previously failed for this tool call. Use a new toolCallId or include an explicit retry nonce/request hash to retry.${error}`;
}

export function resolveSandboxToolOperationReplay(input: {
  operationType: BridgeOperationType;
  existing: ExistingToolOperation | null;
  request: Record<string, unknown>;
}): { kind: "proceed" } | { kind: "replay"; result: Record<string, unknown> } | { kind: "error"; message: string } {
  const existing = input.existing;
  if (!existing) {
    return { kind: "proceed" };
  }
  const sameRequest = sameSandboxRequest(existing.requestJsonRedacted, input.request);
  if (!sameRequest && existing.status !== "failed") {
    return {
      kind: "error",
      message: `SANDBOX_OPERATION_REQUEST_MISMATCH: sandbox ${input.operationType} request does not match the existing operation for this tool call.`,
    };
  }
  if (existing.status === "succeeded") {
    return { kind: "replay", result: existing.resultJsonRedacted };
  }
  if (existing.status === "running") {
    return {
      kind: "error",
      message: `SANDBOX_OPERATION_IN_PROGRESS: sandbox ${input.operationType} is already running for this tool call.`,
    };
  }
  if (sameRequest) {
    return {
      kind: "error",
      message: failedRetryMessage({
        operationType: input.operationType,
        result: existing.resultJsonRedacted,
      }),
    };
  }
  return { kind: "proceed" };
}

export class DaytonaSandboxManager {
  private readonly adapter = new DaytonaAdapter();

  async getOrCreateThreadSandbox(context: SandboxRuntimeContext): Promise<SandboxRef> {
    const existing = await db.query.agentSandboxes.findFirst({
      where: and(
        eq(agentSandboxes.provider, DAYTONA_PROVIDER),
        eq(agentSandboxes.teamId, context.teamId),
        eq(agentSandboxes.workspaceId, context.workspaceId),
        eq(agentSandboxes.threadId, context.threadId),
        inArray(agentSandboxes.status, ["creating", "ready"]),
      ),
      orderBy: [desc(agentSandboxes.updatedAt)],
    });

    if (existing) {
      if (existing.status === "creating") {
        const ageMs = Date.now() - existing.updatedAt.getTime();
        if (ageMs < SANDBOX_CREATING_STALE_MS) {
          throw new Error("SANDBOX_CREATION_IN_PROGRESS: sandbox creation is already running for this thread.");
        }
        const claimed = await db.update(agentSandboxes)
          .set({ status: "error", updatedAt: new Date() })
          .where(and(
            eq(agentSandboxes.id, existing.id),
            eq(agentSandboxes.status, "creating"),
            eq(agentSandboxes.updatedAt, existing.updatedAt),
          ))
          .returning({ id: agentSandboxes.id });
        if (claimed.length === 0) {
          throw new Error(
            "SANDBOX_CREATION_IN_PROGRESS: stale sandbox creation was already claimed by another worker.",
          );
        }
      } else {
        try {
          await this.adapter.getSandbox(existing.providerSandboxId);
          await db.update(agentSandboxes)
            .set({ lastUsedAt: new Date(), updatedAt: new Date() })
            .where(eq(agentSandboxes.id, existing.id));
          return {
            id: existing.id,
            provider: DAYTONA_PROVIDER,
            providerSandboxId: existing.providerSandboxId,
          };
        } catch {
          await db.update(agentSandboxes)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(agentSandboxes.id, existing.id));
        }
      }
    }

    const id = randomUUID();
    const pendingProviderSandboxId = `creating:${id}`;
    const inserted = await db.insert(agentSandboxes).values({
      id,
      provider: DAYTONA_PROVIDER,
      providerSandboxId: pendingProviderSandboxId,
      teamId: context.teamId,
      workspaceId: context.workspaceId,
      threadId: context.threadId,
      userId: context.userId,
      status: "creating",
      networkPolicy: "default",
      lastUsedAt: new Date(),
      expiresAt: sandboxExpiresAt(),
    }).onConflictDoNothing().returning({ id: agentSandboxes.id });

    if (inserted.length === 0) {
      return this.getOrCreateThreadSandbox(context);
    }

    const startedAt = Date.now();
    try {
      const sandbox = await this.adapter.createSandbox({
        snapshot: config.sandbox.daytona.defaultSnapshot || undefined,
        ttlSeconds: config.sandbox.ttlSeconds,
        labels: {
          sourceweft: "true",
          provider: DAYTONA_PROVIDER,
          team_id: context.teamId,
          workspace_id: context.workspaceId,
          thread_id: context.threadId,
          user_id: context.userId,
          environment: process.env.NODE_ENV || "development",
        },
      });
      await db.update(agentSandboxes)
        .set({
          providerSandboxId: sandbox.id,
          status: "ready",
          lastUsedAt: new Date(),
          expiresAt: sandboxExpiresAt(),
          updatedAt: new Date(),
        })
        .where(eq(agentSandboxes.id, id));
      await this.recordOperation({
        context,
        sandboxId: id,
        operationType: "create",
        status: "succeeded",
        result: { providerSandboxId: sandbox.id },
        durationMs: Date.now() - startedAt,
      });
      return { id, provider: DAYTONA_PROVIDER, providerSandboxId: sandbox.id };
    } catch (error) {
      await db.update(agentSandboxes)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(agentSandboxes.id, id));
      await this.recordOperation({
        context,
        sandboxId: id,
        operationType: "create",
        status: "failed",
        result: { error: error instanceof Error ? error.message : String(error) },
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async beginToolOperation(input: {
    context: SandboxRuntimeContext;
    operationType: BridgeOperationType;
    toolCallId: string;
    request?: Record<string, unknown>;
  }): Promise<BeginToolOperationResult> {
    const request = input.request ?? {};
    const existing = await db.query.agentSandboxOperations.findFirst({
      where: and(
        eq(agentSandboxOperations.teamId, input.context.teamId),
        eq(agentSandboxOperations.workspaceId, input.context.workspaceId),
        eq(agentSandboxOperations.threadId, input.context.threadId),
        eq(agentSandboxOperations.operationType, input.operationType),
        eq(agentSandboxOperations.toolCallId, input.toolCallId),
        inArray(agentSandboxOperations.status, ["running", "succeeded", "failed"]),
      ),
      orderBy: [desc(agentSandboxOperations.createdAt)],
    });
    const replay = resolveSandboxToolOperationReplay({
      operationType: input.operationType,
      existing: existing
        ? {
          status: existing.status as "running" | "succeeded" | "failed",
          requestJsonRedacted: existing.requestJsonRedacted,
          resultJsonRedacted: existing.resultJsonRedacted,
        }
        : null,
      request,
    });
    if (replay.kind === "replay") {
      return { kind: "replay", result: replay.result };
    }
    if (replay.kind === "error") {
      throw new Error(replay.message);
    }

    const id = randomUUID();
    const inserted = await db.insert(agentSandboxOperations).values({
      id,
      operationType: input.operationType,
      teamId: input.context.teamId,
      workspaceId: input.context.workspaceId,
      threadId: input.context.threadId,
      messageId: input.context.messageId,
      toolCallId: input.toolCallId,
      userId: input.context.userId,
      status: "running",
      requestJsonRedacted: request,
      resultJsonRedacted: {},
    }).onConflictDoNothing().returning({ id: agentSandboxOperations.id });

    if (inserted.length > 0) {
      return { kind: "claimed", operationId: id };
    }

    const concurrent = await db.query.agentSandboxOperations.findFirst({
      where: and(
        eq(agentSandboxOperations.teamId, input.context.teamId),
        eq(agentSandboxOperations.workspaceId, input.context.workspaceId),
        eq(agentSandboxOperations.threadId, input.context.threadId),
        eq(agentSandboxOperations.operationType, input.operationType),
        eq(agentSandboxOperations.toolCallId, input.toolCallId),
        inArray(agentSandboxOperations.status, ["running", "succeeded"]),
      ),
      orderBy: [desc(agentSandboxOperations.createdAt)],
    });

    if (concurrent && !sameSandboxRequest(concurrent.requestJsonRedacted, request)) {
      throw new Error(
        `SANDBOX_OPERATION_REQUEST_MISMATCH: sandbox ${input.operationType} request does not match the existing operation for this tool call.`,
      );
    }

    if (concurrent?.status === "succeeded") {
      return { kind: "replay", result: concurrent.resultJsonRedacted };
    }

    throw new Error(`SANDBOX_OPERATION_IN_PROGRESS: sandbox ${input.operationType} is already running for this tool call.`);
  }

  async completeToolOperation(input: {
    operationId: string;
    sandboxId?: string | null;
    status: "succeeded" | "failed";
    result?: Record<string, unknown>;
    durationMs?: number;
  }) {
    const now = new Date();
    await db.update(agentSandboxOperations)
      .set({
        sandboxId: input.sandboxId ?? null,
        status: input.status,
        resultJsonRedacted: input.result ?? {},
        durationMs: input.durationMs,
      })
      .where(eq(agentSandboxOperations.id, input.operationId));
    if (input.sandboxId && input.status === "succeeded") {
      await db.update(agentSandboxes)
        .set({
          lastUsedAt: now,
          expiresAt: sandboxExpiresAt(),
          updatedAt: now,
        })
        .where(eq(agentSandboxes.id, input.sandboxId));
    }
  }

  async recordOperation(input: {
    context: SandboxRuntimeContext;
    sandboxId?: string | null;
    operationType: "prepare" | "execute" | "collect" | "create" | "close" | "cleanup";
    status: "proposed" | "approved" | "rejected" | "running" | "succeeded" | "failed" | "canceled";
    toolCallId?: string | null;
    request?: Record<string, unknown>;
    result?: Record<string, unknown>;
    durationMs?: number;
  }) {
    await db.insert(agentSandboxOperations).values({
      id: randomUUID(),
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
    operationType: "prepare" | "execute" | "collect";
    toolCallId: string;
  }): Promise<{ result: Record<string, unknown> } | null> {
    const existing = await db.query.agentSandboxOperations.findFirst({
      where: and(
        eq(agentSandboxOperations.teamId, input.context.teamId),
        eq(agentSandboxOperations.workspaceId, input.context.workspaceId),
        eq(agentSandboxOperations.threadId, input.context.threadId),
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

  adapterForSandbox() {
    return this.adapter;
  }
}
