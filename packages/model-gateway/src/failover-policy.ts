import { resolveStrategyCandidates } from "./config";
import {
  canonicalProviderModel,
  isAdministrativeGatewayCode,
  isFailoverableError,
  normalizeGatewayError,
  selectSurfacedFailoverError,
  summarizeTargetErrors,
  type TargetAttemptError,
} from "./errors";
import { orderByTargetHealth } from "./target-health";
import type {
  GatewayExecutionInput,
  GatewayOperation,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RouteAttempt,
} from "./types";

/**
 * The one failover policy every request path shares: the non-stream endpoints
 * (`runWithTargetFailover`), the gateway chat stream and the LangChain facade
 * the agent runs on. Paths own only their transport — when an attempt counts
 * as committed (a stream's first output) and how its error reaches the caller.
 * Everything else lives here, so the paths cannot drift:
 *
 * - candidate order: the route strategy, then targets in failure cooldown
 *   demoted to the tail (`orderByTargetHealth`), re-read for every request;
 * - when to move on: a failoverable error goes to the next target; a
 *   `STRUCTURED_OUTPUT` failure skips the remaining channels of the same model;
 *   anything else, a caller abort, or a committed stream stops the chain;
 * - target health: every failoverable failure cools the target down, every
 *   success clears it;
 * - the record: each attempt's `routeDecision.attempt` says which attempt it
 *   was, which target the route meant to use, which targets failed before it
 *   and which were skipped for cooldown;
 * - the logs: `model-gateway.cooldown-skip`, `.failover`, `.failover-exhausted`
 *   and `.target-quota`, with one field set whatever the path;
 * - the surfaced error: the most informative of the chain
 *   (`selectSurfacedFailoverError`).
 */

/** The strategy-ordered candidates of one request, resolved once. */
export type CandidatePlan = {
  /** Route strategy order, before any cooldown demotion. */
  readonly strategyOrder: readonly ResolvedRequestTarget[];
  /**
   * `fallbackPolicy: "none"`: the request runs on one target only — the
   * healthiest, so a cooling primary is still skipped.
   */
  readonly singleTarget: boolean;
};

export async function planCandidates(
  config: ResolvedModelGatewayConfig,
  payload: GatewayExecutionInput & {
    model: string;
    metadata?: Record<string, unknown>;
  },
): Promise<CandidatePlan> {
  return {
    strategyOrder: await resolveStrategyCandidates(config, payload),
    singleTarget: payload.fallbackPolicy === "none",
  };
}

/** What the path should do after a failed attempt. */
export type FailoverDecision =
  | { next: true }
  | {
      next: false;
      /** The error to give the caller. */
      surfaced: unknown;
    };

export class FailoverRun {
  /** This request's order: healthy targets first, cooling ones last. */
  readonly candidates: readonly ResolvedRequestTarget[];

  private readonly attempts: TargetAttemptError[] = [];

  private readonly attempted = new Set<ResolvedRequestTarget>();

  private index = 0;

  constructor(
    private readonly config: ResolvedModelGatewayConfig,
    private readonly plan: CandidatePlan,
    private readonly operation: GatewayOperation,
  ) {
    const ordered = orderByTargetHealth(
      [...plan.strategyOrder],
      config.targetHealth,
    );
    this.candidates = plan.singleTarget ? ordered.slice(0, 1) : ordered;
    const first = this.candidates[0];
    const primary = plan.strategyOrder[0];
    if (first && primary && first !== primary) {
      config.logger.warn?.("model-gateway.cooldown-skip", {
        operation,
        alias: primary.routeDecision.alias,
        skipped: this.skippedBefore(first),
        nextProvider: first.provider,
        candidates: this.candidates.length,
      });
    }
  }

  /** The target to try now, or undefined once the chain is done. */
  current(): ResolvedRequestTarget | undefined {
    const target = this.candidates[this.index];
    if (!target) return undefined;
    const attempt: RouteAttempt = {
      index: this.index + 1,
      of: this.candidates.length,
      primaryProvider: this.plan.strategyOrder[0]!.provider,
      ...(this.attempts.length > 0
        ? {
            failoverFrom: this.attempts.map((failed) => ({
              provider: failed.provider,
              providerModel: failed.providerModel,
              errorCode: normalizeGatewayError(failed.error).code,
            })),
          }
        : {}),
    };
    const skipped = this.skippedBefore(target);
    if (skipped.length > 0) attempt.cooldownSkipped = skipped;
    return {
      ...target,
      routeDecision: { ...target.routeDecision, attempt },
    };
  }

  succeeded(target: ResolvedRequestTarget): void {
    this.config.targetHealth.markSuccess(target);
  }

  /**
   * Records a failed attempt and decides what follows. `committed` is a
   * stream whose output already reached the consumer: it is never replayed,
   * and its own error is what the consumer gets.
   */
  failed(
    target: ResolvedRequestTarget,
    error: unknown,
    context: { callerAborted: boolean; committed?: boolean },
  ): FailoverDecision {
    const candidate = this.candidates[this.index]!;
    this.attempted.add(candidate);
    this.attempts.push({
      provider: target.provider,
      providerModel: target.providerModel,
      error,
    });
    const errorCode = normalizeGatewayError(error).code;
    // A cancelled request says nothing about the target's health. Every
    // failoverable failure cools the target down — on the last candidate too,
    // where it cannot help this request but steers the next one. A
    // STRUCTURED_OUTPUT failure does not: the channel is healthy, the
    // model/request combination is what failed.
    if (!context.callerAborted && isFailoverableError(error)) {
      this.config.targetHealth.markFailure(target);
    }
    // An unfunded or unauthorized target is an operations incident, not just
    // one request's problem — loud and greppable on every hit.
    if (!context.callerAborted && isAdministrativeGatewayCode(errorCode)) {
      this.config.logger.warn?.("model-gateway.target-quota", {
        operation: this.operation,
        alias: target.routeDecision.alias,
        provider: target.provider,
        providerModel: target.providerModel,
        errorCode,
      });
    }
    if (context.callerAborted || context.committed) {
      this.index = this.candidates.length;
      return { next: false, surfaced: error };
    }

    const nextIndex = this.nextIndexAfter(candidate, error);
    if (nextIndex >= this.candidates.length) {
      this.index = this.candidates.length;
      const surfaced = selectSurfacedFailoverError(this.attempts);
      if (this.attempts.length > 1) {
        this.config.logger.warn?.("model-gateway.failover-exhausted", {
          operation: this.operation,
          alias: target.routeDecision.alias,
          surfacedErrorCode: normalizeGatewayError(surfaced).code,
          targetErrors: summarizeTargetErrors(this.attempts),
        });
      }
      return { next: false, surfaced };
    }

    this.config.logger.warn?.("model-gateway.failover", {
      operation: this.operation,
      alias: target.routeDecision.alias,
      failedProvider: target.provider,
      failedProviderModel: target.providerModel,
      errorCode,
      nextProvider: this.candidates[nextIndex]!.provider,
      attempt: this.index + 1,
      candidates: this.candidates.length,
      ...(nextIndex > this.index + 1
        ? { skippedSameModelCandidates: nextIndex - this.index - 1 }
        : {}),
    });
    this.index = nextIndex;
    return { next: true };
  }

  /** Past the end when the chain stops here. */
  private nextIndexAfter(
    failed: ResolvedRequestTarget,
    error: unknown,
  ): number {
    if (isFailoverableError(error)) {
      return this.index + 1;
    }
    if (normalizeGatewayError(error).code === "STRUCTURED_OUTPUT") {
      // Replaying the identical request through another channel of the same
      // model is deterministic waste; only a different model gets a try.
      let next = this.index + 1;
      while (
        next < this.candidates.length &&
        canonicalProviderModel(this.candidates[next]!.providerModel) ===
          canonicalProviderModel(failed.providerModel)
      ) {
        next += 1;
      }
      return next;
    }
    return this.candidates.length;
  }

  /**
   * Targets the route ranks ahead of `target` that this request has not
   * tried: they were demoted for cooldown, so `target` serves in their place.
   */
  private skippedBefore(
    target: ResolvedRequestTarget,
  ): Array<{ provider: string; providerModel: string }> {
    const rank = this.plan.strategyOrder.indexOf(target);
    return this.plan.strategyOrder
      .slice(0, Math.max(rank, 0))
      .filter((ahead) => !this.attempted.has(ahead))
      .map((ahead) => ({
        provider: ahead.provider,
        providerModel: ahead.providerModel,
      }));
  }
}

export function startFailoverRun(
  config: ResolvedModelGatewayConfig,
  plan: CandidatePlan,
  operation: GatewayOperation,
): FailoverRun {
  return new FailoverRun(config, plan, operation);
}
