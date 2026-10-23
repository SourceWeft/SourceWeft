import { logger } from "../../../shared/logger";
import { chooseStdioPackage, type McpStdioLaunchPlan } from "./stdio-package";
import {
  enqueueMcpStdioValidate,
  MCP_STDIO_BATCH_SIZE,
  MCP_STDIO_CONCURRENCY,
  MCP_STDIO_SCHEDULED_JOB_ID,
  mcpStdioJobExists,
  recordMcpStdioBatch,
  type McpStdioBatchSummary,
  type McpStdioValidateJobPayload,
} from "./stdio-queue";
import {
  claimMcpStdioValidations,
  findDueMcpStdioValidations,
  writeMcpStdioValidationFailure,
  writeMcpStdioValidationSuccess,
  type ClaimedMcpStdioValidation,
  type DueMcpStdioValidation,
} from "./stdio-repository";
import {
  stdioValidationOutcome,
  unsupportedValidation,
  type McpStdioDriverResult,
} from "./stdio-state";

/**
 * The stdio validation's two halves (Issue #367, W1b): the scheduler queues
 * a batch of due versions; the worker claims them, starts each one's
 * package in a fresh sandbox and stores what it answered. Both take their
 * database, queue and sandbox access as dependencies, so the tests here run
 * without any of them.
 */

// ---------------------------------------------------------------------------
// Scheduler side: queue the due versions
// ---------------------------------------------------------------------------

export type ScheduleMcpStdioDeps = {
  /** Whether this deployment runs a sandbox at all; nothing is queued without one. */
  sandboxEnabled: () => boolean;
  jobExists: (jobId: string) => Promise<boolean>;
  findDue: (input: { limit: number }) => Promise<DueMcpStdioValidation[]>;
  enqueue: (
    payload: McpStdioValidateJobPayload,
    jobId: string,
  ) => Promise<unknown>;
};

/**
 * Queue one batch of {@link MCP_STDIO_BATCH_SIZE} due versions, never-tried
 * ones first. Nothing is queued while the previous batch is still queued or
 * running, and nothing without a sandbox runtime.
 */
export async function scheduleDueMcpStdioValidations(
  deps: ScheduleMcpStdioDeps,
): Promise<{ queued: number; inFlight: boolean; sandboxEnabled: boolean }> {
  if (!deps.sandboxEnabled()) {
    return { queued: 0, inFlight: false, sandboxEnabled: false };
  }
  if (await deps.jobExists(MCP_STDIO_SCHEDULED_JOB_ID)) {
    return { queued: 0, inFlight: true, sandboxEnabled: true };
  }
  const due = await deps.findDue({ limit: MCP_STDIO_BATCH_SIZE });
  if (due.length === 0) {
    return { queued: 0, inFlight: false, sandboxEnabled: true };
  }
  await deps.enqueue(
    { versionIds: due.map((entry) => entry.versionId), reason: "scheduled" },
    MCP_STDIO_SCHEDULED_JOB_ID,
  );
  return { queued: due.length, inFlight: false, sandboxEnabled: true };
}

/** The scheduler's dependencies: the real queue and database, the config's switch. */
export function defaultScheduleMcpStdioDeps(input: {
  sandboxEnabled: () => boolean;
}): ScheduleMcpStdioDeps {
  return {
    sandboxEnabled: input.sandboxEnabled,
    jobExists: mcpStdioJobExists,
    findDue: findDueMcpStdioValidations,
    enqueue: enqueueMcpStdioValidate,
  };
}

// ---------------------------------------------------------------------------
// Worker side: validate a batch
// ---------------------------------------------------------------------------

/** Whether the worker can start a sandbox, and why not when it cannot. */
export type McpStdioSandboxReadiness =
  { ready: true } | { ready: false; reason: string };

export type ValidateMcpStdioBatchDeps = {
  sandboxReadiness: () => Promise<McpStdioSandboxReadiness>;
  claim: (input: {
    versionIds: string[];
    now: Date;
  }) => Promise<ClaimedMcpStdioValidation[]>;
  /**
   * Start the plan in a fresh sandbox and hand back the driver's result, or
   * null when the sandbox ran but the driver left no readable result. Throws
   * when the sandbox itself could not be had or used.
   */
  run: (
    plan: McpStdioLaunchPlan,
    context: { identifier: string; version: string },
  ) => Promise<McpStdioDriverResult | null>;
  writeSuccess: typeof writeMcpStdioValidationSuccess;
  writeFailure: typeof writeMcpStdioValidationFailure;
  record: (summary: McpStdioBatchSummary) => Promise<void>;
  now: () => Date;
};

/** The worker's dependencies, given the sandbox runner it has. */
export function defaultValidateMcpStdioDeps(input: {
  sandboxReadiness: ValidateMcpStdioBatchDeps["sandboxReadiness"];
  run: ValidateMcpStdioBatchDeps["run"];
}): ValidateMcpStdioBatchDeps {
  return {
    sandboxReadiness: input.sandboxReadiness,
    run: input.run,
    claim: claimMcpStdioValidations,
    writeSuccess: writeMcpStdioValidationSuccess,
    writeFailure: writeMcpStdioValidationFailure,
    record: recordMcpStdioBatch,
    now: () => new Date(),
  };
}

function packagesOf(provenance: Record<string, unknown>): unknown {
  const registryServer = provenance.registryServer;
  return registryServer && typeof registryServer === "object"
    ? (registryServer as { packages?: unknown }).packages
    : undefined;
}

/**
 * Validate one batch: claim the versions still due, then for each one —
 * {@link MCP_STDIO_CONCURRENCY} at a time — pick its package, start it in a
 * sandbox and store the outcome. A package the sandbox cannot run is stored
 * as unsupported without a sandbox. A sandbox that could not be had, or a
 * driver that left no result, is not the package's doing: nothing is
 * stored, the version is due again once its claim lapses, and the batch
 * counts it as an error. Without a usable sandbox the batch stops before
 * claiming anything.
 */
export async function validateMcpStdioBatch(
  payload: McpStdioValidateJobPayload,
  deps: ValidateMcpStdioBatchDeps,
): Promise<McpStdioBatchSummary> {
  const startedAt = deps.now();
  const summary: McpStdioBatchSummary = {
    reason: payload.reason,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    requested: payload.versionIds.length,
    claimed: 0,
    processed: 0,
    outcomes: {},
    errors: 0,
    stoppedBy: null,
    sandboxUnavailableReason: null,
  };

  const readiness = await deps.sandboxReadiness();
  if (!readiness.ready) {
    summary.stoppedBy = "sandbox_unavailable";
    summary.sandboxUnavailableReason = readiness.reason;
    logger.warn("MCP stdio validation started nothing: no sandbox runtime", {
      reason: readiness.reason,
      requested: payload.versionIds.length,
    });
    summary.finishedAt = deps.now().toISOString();
    await deps.record(summary);
    return summary;
  }

  const claimed = await deps.claim({
    versionIds: payload.versionIds,
    now: deps.now(),
  });
  summary.claimed = claimed.length;
  const count = (outcome: string) => {
    summary.processed += 1;
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
  };

  const validateOne = async (row: ClaimedMcpStdioValidation) => {
    const choice = chooseStdioPackage(packagesOf(row.provenanceJson));
    if (choice.kind === "unsupported") {
      await deps.writeFailure({
        versionId: row.versionId,
        validation: unsupportedValidation(choice.detail, deps.now()),
      });
      count("unsupported-package");
      return;
    }
    let result: McpStdioDriverResult | null;
    try {
      result = await deps.run(choice.plan, {
        identifier: row.identifier,
        version: row.version,
      });
    } catch (error) {
      summary.errors += 1;
      logger.warn("MCP stdio validation could not use a sandbox", {
        identifier: row.identifier,
        version: row.version,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!result) {
      summary.errors += 1;
      logger.warn("MCP stdio validation driver left no result", {
        identifier: row.identifier,
        version: row.version,
      });
      return;
    }
    const outcome = stdioValidationOutcome(result, deps.now());
    if (outcome.kind === "success") {
      await deps.writeSuccess({
        versionId: row.versionId,
        serverId: row.serverId,
        selfDescription: outcome.selfDescription,
        validatedAt: outcome.validatedAt,
        tools: outcome.tools,
      });
      count("validated");
      logger.info("MCP stdio validation listed tools", {
        identifier: row.identifier,
        version: row.version,
        package: choice.plan.package,
        tools: outcome.tools.length,
        installMs: result.timings.installMs,
        startMs: result.timings.startMs,
      });
    } else {
      await deps.writeFailure({
        versionId: row.versionId,
        validation: outcome.validation,
      });
      count(outcome.validation.reason);
      logger.info("MCP stdio validation failed", {
        identifier: row.identifier,
        version: row.version,
        package: choice.plan.package,
        reason: outcome.validation.reason,
        detail: outcome.validation.detail,
      });
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: MCP_STDIO_CONCURRENCY }, async () => {
      while (next < claimed.length) {
        const row = claimed[next++]!;
        try {
          await validateOne(row);
        } catch (error) {
          // A write failed: the version keeps its claim and is due again
          // once it lapses. The batch goes on with the rest.
          summary.errors += 1;
          logger.warn("MCP stdio validation could not store an outcome", {
            identifier: row.identifier,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),
  );

  summary.finishedAt = deps.now().toISOString();
  await deps.record(summary);
  logger.info("MCP stdio validation batch done", summary);
  return summary;
}
