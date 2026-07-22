/**
 * In-process health memory for route targets, so a target that just failed is
 * not probed again by every single request.
 *
 * Semantics are deliberately "demote, never remove":
 *
 * - A failoverable failure puts the target into a cooldown window. While
 *   cooling, `orderByTargetHealth` moves it to the tail of the candidate list —
 *   requests prefer healthy targets and stop paying a dead primary's failed
 *   round-trip on every call.
 * - Cooldown escalates exponentially on consecutive failures (base 10s,
 *   capped at 10min) and resets on the first success. When the window expires
 *   the target returns to its normal position, so exactly one request per
 *   window probes whether it recovered.
 * - Nothing is ever removed from the candidate list. If every target is
 *   cooling down, the list keeps its original strategy order — the request
 *   still goes out and failover still walks the full chain. Degraded
 *   everywhere must mean "slower", never "no channel".
 *
 * State is per-process and advisory only; it is keyed by the target's
 * provider, base URL and model so two gateways proxying the same upstream do
 * not poison each other.
 */

const DEFAULT_BASE_COOLDOWN_MS = 10_000;
const DEFAULT_MAX_COOLDOWN_MS = 600_000;

type TargetHealthKeyInput = {
  provider: string;
  baseUrl: string;
  providerModel: string;
};

export function targetHealthKey(target: TargetHealthKeyInput): string {
  return `${target.provider}@${target.baseUrl}::${target.providerModel}`;
}

export class TargetHealthRegistry {
  private readonly states = new Map<
    string,
    { consecutiveFailures: number; unhealthyUntilMs: number }
  >();

  constructor(
    private readonly options?: {
      baseCooldownMs?: number;
      maxCooldownMs?: number;
      /** Injectable clock for tests. */
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options?.now?.() ?? Date.now();
  }

  markFailure(target: TargetHealthKeyInput): void {
    const key = targetHealthKey(target);
    const consecutiveFailures =
      (this.states.get(key)?.consecutiveFailures ?? 0) + 1;
    const cooldownMs = Math.min(
      (this.options?.baseCooldownMs ?? DEFAULT_BASE_COOLDOWN_MS) *
        2 ** (consecutiveFailures - 1),
      this.options?.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS,
    );
    this.states.set(key, {
      consecutiveFailures,
      unhealthyUntilMs: this.now() + cooldownMs,
    });
  }

  markSuccess(target: TargetHealthKeyInput): void {
    this.states.delete(targetHealthKey(target));
  }

  isCoolingDown(target: TargetHealthKeyInput): boolean {
    const state = this.states.get(targetHealthKey(target));
    return state !== undefined && state.unhealthyUntilMs > this.now();
  }
}

/**
 * Process-wide default. Module-level on purpose: parts of the host build a
 * fresh gateway config per invocation (e.g. the agent chat model), and health
 * learned by one request must carry over to the next regardless of which
 * config instance it used.
 */
export const defaultTargetHealthRegistry = new TargetHealthRegistry();

/**
 * Stable partition: healthy targets keep their relative order and come first,
 * cooling-down targets keep theirs and come last. All-healthy and all-cooling
 * both degenerate to the input order — the list never shrinks.
 */
export function orderByTargetHealth<T extends TargetHealthKeyInput>(
  targets: T[],
  registry: TargetHealthRegistry,
): T[] {
  if (targets.length <= 1) {
    return targets;
  }
  const healthy: T[] = [];
  const cooling: T[] = [];
  for (const target of targets) {
    (registry.isCoolingDown(target) ? cooling : healthy).push(target);
  }
  return [...healthy, ...cooling];
}
