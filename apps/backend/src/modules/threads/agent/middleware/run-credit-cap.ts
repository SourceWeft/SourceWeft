import { createMiddleware, type AgentMiddleware } from "langchain";
import { ContentError } from "../../../content/errors";
import type { BillingScope } from "../../../../shared/model-gateway/billing/scope";

/**
 * A host-set credit cap (e.g. a ticket's worker-run budget) was reached mid
 * run. Thrown the same way every other fatal turn error is: a `ContentError`
 * carrying this code, which `chat_thread_runs.error_code` ends up storing
 * through the same path as any other model/tool failure.
 */
export const RUN_CREDIT_CAP_EXCEEDED = "RUN_CREDIT_CAP_EXCEEDED";

/**
 * Stops a run once it has spent at least `capCredits`, generically: the
 * threads module knows nothing about tickets or assistants, only that some
 * host set a numeric ceiling on this run's billing scope.
 *
 * Runs before every model call (never a tool call) because the scope only
 * grows at model-call settlement; checking anywhere else would either miss a
 * step or double-count a call still in flight. `getScope` reads the turn's
 * `runtime.billingScope`, which is assigned once per turn before the model is
 * built — absent only for the sliver of turn setup before that happens, when
 * nothing could have been spent yet, so a missing scope never blocks.
 */
export function createRunCreditCapMiddleware(input: {
  capCredits: number;
  getScope: () => BillingScope | undefined;
}): AgentMiddleware {
  return createMiddleware({
    name: "SourceWeftRunCreditCap",
    beforeModel: async () => {
      const scope = input.getScope();
      if (!scope) return;
      const spent = scope
        .meteredCalls()
        .reduce((sum, call) => sum + call.consumedCredits, 0);
      if (spent < input.capCredits) return;
      throw new ContentError(
        402,
        RUN_CREDIT_CAP_EXCEEDED,
        `This run reached its credit cap of ${input.capCredits}; ${spent} credits were already consumed.`,
        {
          recoverable: false,
          details: { capCredits: input.capCredits, spent },
        },
      );
    },
  });
}
