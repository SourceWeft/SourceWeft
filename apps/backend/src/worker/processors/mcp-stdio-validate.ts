import type { Job } from "bullmq";
import type {
  McpStdioBatchSummary,
  McpStdioValidateJobPayload,
} from "../../modules/market/validation/stdio-queue";
import {
  defaultValidateMcpStdioDeps,
  validateMcpStdioBatch,
  type ValidateMcpStdioBatchDeps,
} from "../../modules/market/validation/stdio-validate";
import {
  mcpStdioSandboxReadiness,
  runMcpStdioValidationInSandbox,
} from "./mcp-stdio-sandbox";

/**
 * One batch of stdio package validations (`mcp-stdio-validate`, Issue #367
 * W1b). Per-version outcomes are stored on the versions and never fail the
 * job; a thrown error (the database is down) fails it, and the versions it
 * did not reach are due again once their claim lapses.
 */
export async function processMcpStdioValidateJob(
  job: Job<Record<string, unknown>>,
  deps?: ValidateMcpStdioBatchDeps,
): Promise<McpStdioBatchSummary> {
  const payload = job.data as Partial<McpStdioValidateJobPayload>;
  const versionIds = payload.versionIds;
  if (
    !Array.isArray(versionIds) ||
    !versionIds.every((id) => typeof id === "string" && id)
  ) {
    throw new Error("mcp-stdio-validate job has no versionIds");
  }
  const reason = payload.reason === "admin" ? "admin" : "scheduled";
  return validateMcpStdioBatch(
    { versionIds, reason },
    deps ??
      defaultValidateMcpStdioDeps({
        sandboxReadiness: mcpStdioSandboxReadiness,
        run: runMcpStdioValidationInSandbox,
      }),
  );
}
