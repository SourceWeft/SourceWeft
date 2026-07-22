import { resolveRequestCandidates } from "../config";
import { isFailoverableError, normalizeGatewayError } from "../errors";
import type {
  GatewayExecutionInput,
  GatewayOperation,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

/**
 * Runs a request against the route's candidate targets in order, moving to the
 * next target only when the failed attempt could plausibly succeed elsewhere
 * (`isFailoverableError`) — a drained balance or dead upstream fails over, a
 * malformed request does not.
 *
 * Never fails over when the caller's own signal aborted: a cancelled request
 * must not be replayed against another provider. BYOK requests never fail over
 * because they resolve to exactly one candidate (`resolveRequestCandidates`).
 *
 * Streaming cannot use this helper — once output has reached the consumer the
 * attempt is committed, so `ModelGatewayChatEndpoint.stream` implements the
 * same policy with a first-output cutoff instead.
 */
export async function runWithTargetFailover<T>(input: {
  config: ResolvedModelGatewayConfig;
  payload: GatewayExecutionInput & {
    model: string;
    metadata?: Record<string, unknown>;
  };
  operation: GatewayOperation;
  /** The caller's original signal, before any per-attempt timeout composition. */
  callerSignal?: AbortSignal;
  attempt: (target: ResolvedRequestTarget) => Promise<T>;
}): Promise<T> {
  const candidates = await resolveRequestCandidates(input.config, input.payload);
  let lastError: unknown;

  for (const [index, target] of candidates.entries()) {
    try {
      const result = await input.attempt(target);
      input.config.targetHealth.markSuccess(target);
      return result;
    } catch (error) {
      lastError = error;
      const callerAborted = input.callerSignal?.aborted ?? false;
      // A cancelled request says nothing about the target's health; every
      // failoverable failure cools the target down — including on the last
      // candidate, where it cannot help this request but steers the next one.
      if (!callerAborted && isFailoverableError(error)) {
        input.config.targetHealth.markFailure(target);
      }
      const next = candidates[index + 1];
      if (!next || callerAborted || !isFailoverableError(error)) {
        throw error;
      }
      input.config.logger.warn?.("model-gateway.failover", {
        operation: input.operation,
        alias: target.routeDecision.alias,
        failedProvider: target.provider,
        failedProviderModel: target.providerModel,
        errorCode: normalizeGatewayError(error).code,
        nextProvider: next.provider,
        attempt: index + 1,
        candidates: candidates.length,
      });
    }
  }

  throw lastError;
}
