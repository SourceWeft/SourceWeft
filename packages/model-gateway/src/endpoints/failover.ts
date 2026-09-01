import { resolveRequestCandidates } from "../config";
import {
  canonicalProviderModel,
  isAdministrativeGatewayCode,
  isFailoverableError,
  normalizeGatewayError,
  selectSurfacedFailoverError,
  summarizeTargetErrors,
  type TargetAttemptError,
} from "../errors";
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
 * `STRUCTURED_OUTPUT` gets the model-level rule: replaying the identical
 * request through another channel of the same model is deterministic waste, so
 * remaining candidates serving the same `providerModel` are skipped and only a
 * genuinely different model gets a try.
 *
 * When the chain is exhausted, the surfaced error is the most *informative*
 * one, not the last one (`selectSurfacedFailoverError`) — a tail target that
 * happens to be unfunded must not mask the substantive failure that preceded
 * it.
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
  const resolvedCandidates = await resolveRequestCandidates(
    input.config,
    input.payload,
  );
  const candidates =
    input.payload.fallbackPolicy === "none"
      ? resolvedCandidates.slice(0, 1)
      : resolvedCandidates;
  const attempts: TargetAttemptError[] = [];

  let index = 0;
  while (index < candidates.length) {
    const target = candidates[index]!;
    try {
      const result = await input.attempt(target);
      input.config.targetHealth.markSuccess(target);
      return result;
    } catch (error) {
      attempts.push({
        provider: target.provider,
        providerModel: target.providerModel,
        error,
      });
      const callerAborted = input.callerSignal?.aborted ?? false;
      const errorCode = normalizeGatewayError(error).code;
      // A cancelled request says nothing about the target's health; every
      // failoverable failure cools the target down — including on the last
      // candidate, where it cannot help this request but steers the next one.
      // A STRUCTURED_OUTPUT failure deliberately does not: the channel is
      // healthy, the model/request combination is what failed.
      if (!callerAborted && isFailoverableError(error)) {
        input.config.targetHealth.markFailure(target);
      }
      // An unfunded or unauthorized target is an operations incident, not just
      // one request's problem — loud and greppable on every hit.
      if (!callerAborted && isAdministrativeGatewayCode(errorCode)) {
        input.config.logger.warn?.("model-gateway.target-quota", {
          operation: input.operation,
          alias: target.routeDecision.alias,
          provider: target.provider,
          providerModel: target.providerModel,
          errorCode,
        });
      }
      if (callerAborted) {
        throw error;
      }

      let nextIndex = -1;
      if (isFailoverableError(error)) {
        nextIndex = index + 1;
      } else if (errorCode === "STRUCTURED_OUTPUT") {
        nextIndex = index + 1;
        while (
          nextIndex < candidates.length &&
          canonicalProviderModel(candidates[nextIndex]!.providerModel) ===
            canonicalProviderModel(target.providerModel)
        ) {
          nextIndex += 1;
        }
      }

      if (nextIndex < 0 || nextIndex >= candidates.length) {
        const surfaced = selectSurfacedFailoverError(attempts);
        if (attempts.length > 1) {
          input.config.logger.warn?.("model-gateway.failover-exhausted", {
            operation: input.operation,
            alias: target.routeDecision.alias,
            surfacedErrorCode: normalizeGatewayError(surfaced).code,
            targetErrors: summarizeTargetErrors(attempts),
          });
        }
        throw surfaced;
      }

      input.config.logger.warn?.("model-gateway.failover", {
        operation: input.operation,
        alias: target.routeDecision.alias,
        failedProvider: target.provider,
        failedProviderModel: target.providerModel,
        errorCode,
        nextProvider: candidates[nextIndex]!.provider,
        attempt: index + 1,
        candidates: candidates.length,
        ...(nextIndex > index + 1
          ? { skippedSameModelCandidates: nextIndex - index - 1 }
          : {}),
      });
      index = nextIndex;
    }
  }

  throw selectSurfacedFailoverError(attempts);
}
