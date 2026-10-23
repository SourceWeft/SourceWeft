import {
  defaultScheduleMcpStdioDeps,
  scheduleDueMcpStdioValidations,
} from "../../modules/market/validation/stdio-validate";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";

/**
 * How often a batch of stdio packages is queued for validation in the
 * sandbox (Issue #367, W1b). With `MCP_STDIO_BATCH_SIZE` versions a batch
 * this paces the first pass over the catalog's packages across days (see
 * `modules/market/validation/stdio-queue.ts`); a batch still in flight is
 * never joined by a second one. A constant on purpose: the pace is a
 * property of the sandbox's cost and of third-party code, not a deployment
 * knob.
 */
export const MCP_STDIO_SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Queue the next batch of stdio validations. Only queues, and only when this
 * deployment has a sandbox runtime at all (`SOURCEWEFT_SANDBOX_ENABLED`):
 * the worker creates the sandboxes.
 */
export async function scheduleMcpStdioValidations(): Promise<void> {
  const result = await scheduleDueMcpStdioValidations(
    defaultScheduleMcpStdioDeps({
      sandboxEnabled: () => config.sandbox.enabled,
    }),
  );
  if (result.queued > 0) {
    logger.info("Queued MCP stdio validation batch", result);
  }
}
