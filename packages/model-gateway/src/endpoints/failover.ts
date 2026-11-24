import { planCandidates, startFailoverRun } from "../failover-policy";
import type {
  GatewayExecutionInput,
  GatewayOperation,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

/**
 * Runs a non-streaming request against the route's candidate targets under
 * the shared failover policy (`failover-policy.ts`): the next target only when
 * the failed attempt could plausibly succeed elsewhere, same-model channels
 * skipped after a `STRUCTURED_OUTPUT` failure, never after the caller's own
 * signal aborted, and the most informative error surfaced when the chain is
 * exhausted. BYOK requests never fail over because they resolve to exactly one
 * candidate.
 *
 * Each attempt receives its target with `routeDecision.attempt` filled in, so
 * the generation it records says where it sat in the chain.
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
  const run = startFailoverRun(
    input.config,
    await planCandidates(input.config, input.payload),
    input.operation,
  );
  for (;;) {
    const target = run.current()!;
    try {
      input.callerSignal?.throwIfAborted();
      const result = await input.attempt(target);
      run.succeeded(target);
      return result;
    } catch (error) {
      const decision = run.failed(target, error, {
        callerAborted: input.callerSignal?.aborted ?? false,
      });
      if (!decision.next) throw decision.surfaced;
    }
  }
}
