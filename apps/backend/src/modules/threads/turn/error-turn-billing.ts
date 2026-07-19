import type { MeteredLlmCallTrace, PreflightBillingTrace } from "./types";

function sumConsumedCredits(
  entries: ReadonlyArray<{ consumedCredits: number }>,
) {
  return entries.reduce((sum, entry) => sum + entry.consumedCredits, 0);
}

/**
 * Billing figures and metadata for a turn that ended in an error.
 *
 * Shared because the durable and non-durable error paths must report identical
 * billing for the same failure — they persist to the same message shape, one by
 * creating a record and one by updating an existing one. They previously held
 * byte-identical copies of this derivation, which had to be kept in lockstep by
 * hand.
 *
 * Deliberately not shared with the success path in `finalizer.ts`: that one
 * carries a different skip reason (`llm_call_level_metering`), a different
 * no-calls reason (`no_metered_llm_calls`), and a `billedBy` field that exists
 * nowhere else. Unifying them would mean threading three string literals
 * through a mode flag, which is worse than the duplication it removes.
 */
export function buildErrorTurnBilling(input: {
  meteredLlmCalls: readonly MeteredLlmCallTrace[];
  preflightBilling: readonly PreflightBillingTrace[];
}) {
  const meteredLlmCalls = [...input.meteredLlmCalls];
  const meteredLlmCreditsConsumed = sumConsumedCredits(meteredLlmCalls);
  const preflightCreditsConsumed = sumConsumedCredits(input.preflightBilling);

  const allSkipped =
    meteredLlmCalls.length > 0 &&
    meteredLlmCalls.every((call) => call.billingStatus === "skipped");

  return {
    /** Goes on the message record's own `creditsConsumed` column. */
    creditsConsumed: preflightCreditsConsumed + meteredLlmCreditsConsumed,
    /** Spread into the message record's `metadata`. */
    metadata: {
      billingFinalizerSkipped: true,
      billingFinalizerSkipReason: "model_error",
      meteredLlmCalls,
      meteredLlmCreditsConsumed,
      billingSkipped: meteredLlmCalls.length === 0 || allSkipped,
      billingSkipReason:
        meteredLlmCalls.length === 0
          ? "model_error_before_llm_usage"
          : allSkipped
            ? (meteredLlmCalls
                .map((call) => call.skipReason)
                .find((reason): reason is string => Boolean(reason)) ??
              "llm_calls_skipped")
            : null,
      preflightBilling: [...input.preflightBilling],
      preflightCreditsConsumed,
    },
  };
}
