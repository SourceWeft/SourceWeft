import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { config } from "../../../../shared/config";
import { db } from "../../../../shared/database";
import { agentSandboxOperations, agentSandboxes } from "../../../../shared/db/schema";
import { logger } from "../../../../shared/logger";
import { DaytonaAdapter } from "./daytona-adapter";

const CLEANUP_LIMIT = 25;

function isProviderNotFoundOrExpired(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("SANDBOX_NOT_FOUND_OR_EXPIRED");
}

export async function cleanupExpiredDaytonaSandboxes() {
  if (
    !config.sandbox.enabled ||
    config.sandbox.provider !== "daytona" ||
    !config.sandbox.daytona.apiKey ||
    !config.sandbox.daytona.apiUrl
  ) {
    return { cleaned: 0 };
  }

  const rows = await db.query.agentSandboxes.findMany({
    where: and(
      eq(agentSandboxes.provider, "daytona"),
      eq(agentSandboxes.status, "ready"),
      lte(agentSandboxes.expiresAt, new Date()),
    ),
    limit: CLEANUP_LIMIT,
  });
  if (rows.length === 0) {
    return { cleaned: 0 };
  }

  const adapter = new DaytonaAdapter();
  let cleaned = 0;
  for (const sandbox of rows) {
    const startedAt = Date.now();
    const operationId = randomUUID();
    const operationToolCallId = `cleanup:${sandbox.id}`;
    const claimed = await db.insert(agentSandboxOperations).values({
      id: operationId,
      sandboxId: sandbox.id,
      operationType: "cleanup",
      teamId: sandbox.teamId,
      workspaceId: sandbox.workspaceId,
      threadId: sandbox.threadId,
      userId: sandbox.userId,
      status: "running",
      toolCallId: operationToolCallId,
      requestJsonRedacted: {
        providerSandboxId: sandbox.providerSandboxId,
        reason: "ttl_expired",
      },
    }).onConflictDoNothing().returning({ id: agentSandboxOperations.id });

    if (claimed.length === 0) {
      continue;
    }

    try {
      await adapter.deleteSandbox(sandbox.providerSandboxId);
      await db.update(agentSandboxes)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(agentSandboxes.id, sandbox.id));
      await db.update(agentSandboxOperations).set({
        status: "succeeded",
        resultJsonRedacted: {
          providerSandboxId: sandbox.providerSandboxId,
          finalStatus: "expired",
        },
        durationMs: Date.now() - startedAt,
      }).where(eq(agentSandboxOperations.id, operationId));
      cleaned += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isProviderNotFoundOrExpired(error)) {
        await db.update(agentSandboxes)
          .set({ status: "expired", updatedAt: new Date() })
          .where(eq(agentSandboxes.id, sandbox.id));
        await db.update(agentSandboxOperations).set({
          status: "succeeded",
          resultJsonRedacted: {
            providerSandboxId: sandbox.providerSandboxId,
            finalStatus: "expired",
            providerAlreadyDeleted: true,
          },
          durationMs: Date.now() - startedAt,
        }).where(eq(agentSandboxOperations.id, operationId));
        cleaned += 1;
        continue;
      }

      logger.warn("Failed to cleanup Daytona sandbox", {
        sandboxId: sandbox.id,
        providerSandboxId: sandbox.providerSandboxId,
        error: message,
      });
      await db.update(agentSandboxOperations).set({
        status: "failed",
        resultJsonRedacted: {
          providerSandboxId: sandbox.providerSandboxId,
          error: message,
          finalStatus: sandbox.status,
        },
        durationMs: Date.now() - startedAt,
      }).where(eq(agentSandboxOperations.id, operationId));
    }
  }

  return { cleaned };
}
