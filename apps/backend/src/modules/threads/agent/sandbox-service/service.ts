import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import {
  AgentSandboxService,
  SANDBOX_OPERATION_STALE_GRACE_MS,
  SANDBOX_OPERATION_STALE_RELEASED_CODE,
  SANDBOX_RELEASE_LEASE_GRACE_MS,
  type AgentSandboxRuntimeForTurn,
  type SandboxRuntimeName,
  type SandboxRuntimeRequest,
  type SandboxServiceConfig,
} from "@sourceweft/builtin-tool-sandbox";
import { agentSandboxes, agentSandboxOperations, db } from "@sourceweft/db";
import { config } from "../../../../shared/config";
import { logger } from "../../../../shared/logger";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { getSandboxProviderFactory } from "./provider-registry";
import { DrizzleSandboxOperationStore, DrizzleSandboxStore } from "./stores";


const CLEANUP_LIMIT = 25;
const STALE_OPERATION_LIMIT = 100;

function currentSandboxServiceConfig(): SandboxServiceConfig {
  return {
    enabled: config.sandbox.enabled,
    toolApprovalEnabled: config.sandbox.toolApprovalEnabled,
    provider: config.sandbox.provider,
    limits: {
      ttlSeconds: config.sandbox.ttlSeconds,
      commandTimeoutMs: config.sandbox.commandTimeoutMs,
      maxOutputChars: config.sandbox.maxOutputChars,
      maxPrepareFileBytes: config.sandbox.maxPrepareFileBytes,
      maxPrepareTotalBytes: config.sandbox.maxPrepareTotalBytes,
      maxCollectFileBytes: config.sandbox.maxCollectFileBytes,
      maxCollectTotalBytes: config.sandbox.maxCollectTotalBytes,
    },
  };
}

const sandboxService = new AgentSandboxService({
  getConfig: currentSandboxServiceConfig,
  getProviderFactory: getSandboxProviderFactory,
  logWarn: (message, meta) => logger.warn(message, meta),
});

function isProviderNotFoundOrExpired(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("SANDBOX_NOT_FOUND_OR_EXPIRED");
}

export const agentSandboxService = {
  createRuntimeForTurn(
    input: SandboxRuntimeRequest,
  ): AgentSandboxRuntimeForTurn | null {
    return sandboxService.createRuntimeForTurn(
      input,
      new DrizzleSandboxStore(),
      new DrizzleSandboxOperationStore(),
    );
  },

  logStartupWarning(runtime: SandboxRuntimeName) {
    sandboxService.logStartupWarning(runtime);
  },

  warnIfHitlBypassed(input: {
    interruptOn: Record<string, unknown>;
    boundSandboxToolNames: string[];
  }) {
    if (!config.sandbox.toolApprovalEnabled) {
      return;
    }

    const missingRequiredTools: string[] = [AGENT_TOOL_NAMES.execute];
    for (const toolName of input.boundSandboxToolNames) {
      if (
        toolName === AGENT_TOOL_NAMES.prepareSandboxWorkspace ||
        toolName === AGENT_TOOL_NAMES.collectSandboxOutputs
      ) {
        missingRequiredTools.push(toolName);
      }
    }

    const missingInterrupts = Array.from(new Set(missingRequiredTools)).filter(
      (toolName) => !input.interruptOn[toolName],
    );
    if (missingInterrupts.length === 0) {
      return;
    }

    logger.warn(
      "Sandbox runtime is active but HITL confirmation is missing for one or more sandbox operations",
      {
        missingInterrupts,
        boundSandboxToolNames: input.boundSandboxToolNames,
      },
    );
  },

  async cleanupExpiredSandboxes() {
    const runtimeConfig = currentSandboxServiceConfig();
    if (!runtimeConfig.enabled) {
      return { cleaned: 0 };
    }

    const factory = getSandboxProviderFactory(runtimeConfig.provider);
    const providerStatus = factory?.getConfigurationStatus();
    if (!factory || !providerStatus?.configured) {
      return { cleaned: 0 };
    }

    const rows = await db.query.agentSandboxes.findMany({
      where: and(
        eq(agentSandboxes.provider, factory.id),
        eq(agentSandboxes.status, "ready"),
        lte(agentSandboxes.expiresAt, new Date()),
      ),
      limit: CLEANUP_LIMIT,
    });
    if (rows.length === 0) {
      return { cleaned: 0 };
    }

    const provider = factory.createProvider();
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
          provider: factory.id,
          providerSandboxId: sandbox.providerSandboxId,
          reason: "ttl_expired",
        },
      }).onConflictDoNothing().returning({ id: agentSandboxOperations.id });

      if (claimed.length === 0) {
        continue;
      }

      try {
        await provider.deleteSandbox(sandbox.providerSandboxId);
        await db.update(agentSandboxes)
          .set({ status: "expired", updatedAt: new Date() })
          .where(eq(agentSandboxes.id, sandbox.id));
        await db.update(agentSandboxOperations).set({
          status: "succeeded",
          resultJsonRedacted: {
            provider: factory.id,
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
              provider: factory.id,
              providerSandboxId: sandbox.providerSandboxId,
              finalStatus: "expired",
              providerAlreadyDeleted: true,
            },
            durationMs: Date.now() - startedAt,
          }).where(eq(agentSandboxOperations.id, operationId));
          cleaned += 1;
          continue;
        }

        logger.warn("Failed to cleanup sandbox", {
          sandboxId: sandbox.id,
          provider: factory.id,
          providerSandboxId: sandbox.providerSandboxId,
          error: message,
        });
        await db.update(agentSandboxOperations).set({
          status: "failed",
          resultJsonRedacted: {
            provider: factory.id,
            providerSandboxId: sandbox.providerSandboxId,
            error: message,
            finalStatus: sandbox.status,
          },
          durationMs: Date.now() - startedAt,
        }).where(eq(agentSandboxOperations.id, operationId));
      }
    }

    return { cleaned };
  },

  async releaseThreadSandboxLease(input: {
    context: SandboxRuntimeRequest["context"];
    reason: string;
  }) {
    const runtimeConfig = currentSandboxServiceConfig();
    if (!runtimeConfig.enabled) {
      return { released: 0 };
    }

    const factory = getSandboxProviderFactory(runtimeConfig.provider);
    const providerStatus = factory?.getConfigurationStatus();
    if (!factory || !providerStatus?.configured) {
      return { released: 0 };
    }

    const store = new DrizzleSandboxStore();
    const released = await store.releaseReadyThreadSandboxLease({
      context: input.context,
      provider: factory.id,
      expiresAt: new Date(Date.now() + SANDBOX_RELEASE_LEASE_GRACE_MS),
      reason: input.reason,
    });
    return { released };
  },

  async cleanupStaleSandboxOperations() {
    const runtimeConfig = currentSandboxServiceConfig();
    if (!runtimeConfig.enabled) {
      return { released: 0 };
    }

    const staleBefore = new Date(
      Date.now() -
        runtimeConfig.limits.commandTimeoutMs -
        SANDBOX_OPERATION_STALE_GRACE_MS,
    );
    const rows = await db.query.agentSandboxOperations.findMany({
      where: and(
        eq(agentSandboxOperations.status, "running"),
        lte(agentSandboxOperations.createdAt, staleBefore),
      ),
      limit: STALE_OPERATION_LIMIT,
    });
    if (rows.length === 0) {
      return { released: 0 };
    }

    let released = 0;
    for (const operation of rows) {
      const updated = await db.update(agentSandboxOperations)
        .set({
          status: "failed",
          resultJsonRedacted: {
            ...(operation.resultJsonRedacted ?? {}),
            errorCode: SANDBOX_OPERATION_STALE_RELEASED_CODE,
            error:
              "Sandbox operation was marked failed after exceeding the stale operation threshold.",
          },
        })
        .where(
          and(
            eq(agentSandboxOperations.id, operation.id),
            eq(agentSandboxOperations.status, "running"),
            lte(agentSandboxOperations.createdAt, staleBefore),
          ),
        )
        .returning({ id: agentSandboxOperations.id });
      if (updated.length === 0) {
        continue;
      }
      released += 1;
    }

    return { released };
  },
};
