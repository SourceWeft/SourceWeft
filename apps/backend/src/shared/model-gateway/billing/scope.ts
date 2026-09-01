import type { BillingMode } from "@sourceweft/contracts";
import type {
  ModelCallObservation,
  UsageInfo,
} from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "../../../modules/content/billing-port";
import type {
  MeteredModelCallTrace,
  ModelCallBillingOptions,
  ModelUsageContext,
} from "./context";
import {
  settleModelCall,
  type MeterUsageFn,
  type ScheduleProviderCostReconciliationFn,
} from "./settle";
import { addUsage } from "./usage";

export interface BillingScope {
  readonly context: ModelUsageContext;
  readonly billingMode: BillingMode;
  /** Settled calls in order, feeding the turn outcome's metered-call list. */
  meteredCalls(): readonly MeteredModelCallTrace[];
  /**
   * Usage summed across every settled call in this scope.
   *
   * Providers report cumulative usage per call, so this sums across calls while
   * each call's own figure is last-wins.
   */
  totalUsage(): UsageInfo | undefined;
  /** Remaining scope-local credit budget; drives the per-call gate with no DB read. */
  remainingCredits(): number;
  settle(input: {
    options: ModelCallBillingOptions;
    usage: UsageInfo | undefined;
    observation?: ModelCallObservation;
  }): Promise<MeteredModelCallTrace | null>;
}

/**
 * Derives the idempotency key for one call within a scope.
 *
 * An explicit key always wins: every call site migrated onto the wrapper must
 * pin the key it used before, because changing a key on an already-metered
 * reference charges the customer twice. The derived form is for paths that were
 * never billed before, and is stable across a replay of the same scope because
 * the sequence counter restarts with the scope.
 */
export function deriveIdempotencyKey(input: {
  explicitKey?: string;
  scopeId: string;
  operation: string;
  scopeKey?: string | number;
  seq: number;
}) {
  const explicit = input.explicitKey?.trim();
  if (explicit) {
    return explicit;
  }
  return `${input.scopeId}:${input.operation}:${input.scopeKey ?? 0}:${input.seq}`;
}

export function openBillingScope(input: {
  context: ModelUsageContext;
  billing: ContentBillingPort;
  billingMode: BillingMode;
  availableCredits: number;
  meterUsage?: MeterUsageFn;
  scheduleReconciliation?: ScheduleProviderCostReconciliationFn;
}): BillingScope {
  const traces: MeteredModelCallTrace[] = [];
  const sequences = new Map<string, number>();
  let remaining = input.availableCredits;

  function nextSeq(operation: string, scopeKey?: string | number) {
    const key = `${operation}:${scopeKey ?? 0}`;
    const seq = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, seq);
    return seq;
  }

  return {
    context: input.context,
    billingMode: input.billingMode,
    meteredCalls: () => traces,
    totalUsage: () =>
      traces.reduce<UsageInfo | undefined>(
        (total, trace) => addUsage(total, trace.usage),
        undefined,
      ),
    remainingCredits: () => remaining,
    async settle({ options, usage, observation }) {
      const seq = nextSeq(options.operation, options.scopeKey);
      const idempotencyKey = deriveIdempotencyKey({
        explicitKey: options.idempotencyKey,
        scopeId: input.context.scopeId,
        operation: options.operation,
        scopeKey: options.scopeKey,
        seq,
      });
      const referenceId =
        options.referenceId ??
        `${input.context.scopeKind}:${input.context.scopeId}:${options.operation}:${seq}`;

      const trace = await settleModelCall({
        context: input.context,
        billing: input.billing,
        options,
        usage,
        observation,
        idempotencyKey,
        referenceId,
        meterUsage: input.meterUsage,
        scheduleReconciliation: input.scheduleReconciliation,
      });

      if (trace) {
        traces.push(trace);
        remaining -= trace.consumedCredits;
      }
      return trace;
    },
  };
}
