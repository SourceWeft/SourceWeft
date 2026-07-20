/**
 * Named command budgets for sandbox execution.
 *
 * A budget names a *class of operation*, never a caller and never a capability.
 * There are exactly two classes because there are exactly two ways a command
 * can reach the sandbox:
 *
 * - `interactive` — issued inside a conversational turn. The command text comes
 *   from the model, so the budget is the ceiling that stops one runaway
 *   model-issued command from holding a sandbox for minutes at a time.
 * - `batch` — issued by host code running a deterministic pipeline (installs,
 *   type checks, renders) with no model in the loop. These legitimately run for
 *   minutes, and the command text is written by us, not generated.
 *
 * Adding a third class should be rare; a new long-running *host* operation
 * simply asks for `batch` when it builds its runtime and needs no plumbing
 * change.
 */
export const SANDBOX_COMMAND_BUDGETS = ["interactive", "batch"] as const;

export type SandboxCommandBudget = (typeof SANDBOX_COMMAND_BUDGETS)[number];

/**
 * The budget used whenever a caller does not name one. It must stay
 * `interactive`: the agent turn builds its runtime without naming a budget, so
 * the default is what the model actually runs under. Changing this constant
 * hands the model the long budget.
 */
export const DEFAULT_SANDBOX_COMMAND_BUDGET: SandboxCommandBudget =
  "interactive";

export type SandboxCommandBudgetLimits = {
  commandBudgetsMs: Readonly<Record<SandboxCommandBudget, number>>;
  maxCommandTimeoutMs: number;
};

/**
 * Resolves the wall-clock timeout for one class of operation.
 *
 * Every configured budget is clamped to `maxCommandTimeoutMs`. Clamping rather
 * than rejecting is deliberate: a too-large budget is a misconfiguration, and
 * refusing to build the runtime would take sandbox execution down entirely
 * rather than degrade it. It is not silent either — `logStartupWarning` reports
 * the resolved budgets alongside the ceiling, so an operator sees the effective
 * value at boot. Remove the clamp and a single env var typo lets a host
 * operation pin a sandbox for as long as the provider allows.
 */
export function resolveSandboxCommandTimeoutMs(input: {
  limits: SandboxCommandBudgetLimits;
  budget?: SandboxCommandBudget;
}): number {
  const requested =
    input.limits.commandBudgetsMs[
      input.budget ?? DEFAULT_SANDBOX_COMMAND_BUDGET
    ];
  return Math.min(requested, input.limits.maxCommandTimeoutMs);
}

/**
 * The longest any single sandbox command can run under these limits.
 *
 * Staleness sweeps use this, not the interactive budget: an operation row is
 * only presumed dead once *no* budget could still have it running. Reading the
 * interactive budget here would mark a live `batch` command failed mid-flight.
 */
export function maxSandboxCommandTimeoutMs(
  limits: SandboxCommandBudgetLimits,
): number {
  return Math.min(
    Math.max(...SANDBOX_COMMAND_BUDGETS.map((b) => limits.commandBudgetsMs[b])),
    limits.maxCommandTimeoutMs,
  );
}
