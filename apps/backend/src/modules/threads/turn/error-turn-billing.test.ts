import assert from "node:assert/strict";
import { test } from "vitest";
import type { MeteredLlmCallTrace, PreflightBillingTrace } from "./types";
import { buildErrorTurnBilling } from "./error-turn-billing";

function meteredCall(
  overrides: Partial<MeteredLlmCallTrace> = {},
): MeteredLlmCallTrace {
  return {
    id: "call_1",
    operation: "chat.stream",
    modelKind: "chat",
    modelAlias: "gpt-4o",
    profileAlias: "default-chat",
    gatewayConfigId: "gw_1",
    billingStatus: "metered",
    consumedCredits: 0,
    idempotencyKey: "k",
    referenceId: "r",
    ...overrides,
  } as MeteredLlmCallTrace;
}

function preflight(consumedCredits: number): PreflightBillingTrace {
  return { consumedCredits } as PreflightBillingTrace;
}

test("credits sum preflight and metered spend", () => {
  const result = buildErrorTurnBilling({
    meteredLlmCalls: [
      meteredCall({ consumedCredits: 3 }),
      meteredCall({ id: "call_2", consumedCredits: 2 }),
    ],
    preflightBilling: [preflight(4)],
  });

  assert.equal(result.creditsConsumed, 9);
  assert.equal(result.metadata.meteredLlmCreditsConsumed, 5);
  assert.equal(result.metadata.preflightCreditsConsumed, 4);
});

// No LLM call ran at all: the failure happened before any usage.
test("no metered calls reports the pre-usage skip reason", () => {
  const result = buildErrorTurnBilling({
    meteredLlmCalls: [],
    preflightBilling: [],
  });

  assert.equal(result.metadata.billingSkipped, true);
  assert.equal(
    result.metadata.billingSkipReason,
    "model_error_before_llm_usage",
  );
  assert.equal(result.creditsConsumed, 0);
});

// Calls ran but every one was skipped (e.g. embedding/rerank/BYOK): surface the
// first concrete skip reason rather than the pre-usage one.
test("all-skipped calls surface the first skip reason", () => {
  const result = buildErrorTurnBilling({
    meteredLlmCalls: [
      meteredCall({ billingStatus: "skipped", skipReason: undefined }),
      meteredCall({ id: "call_2", billingStatus: "skipped", skipReason: "byok" }),
    ],
    preflightBilling: [],
  });

  assert.equal(result.metadata.billingSkipped, true);
  assert.equal(result.metadata.billingSkipReason, "byok");
});

test("all-skipped calls with no named reason fall back", () => {
  const result = buildErrorTurnBilling({
    meteredLlmCalls: [meteredCall({ billingStatus: "skipped" })],
    preflightBilling: [],
  });

  assert.equal(result.metadata.billingSkipReason, "llm_calls_skipped");
});

// At least one call genuinely billed: not a skip, no skip reason.
test("a genuinely billed call is not marked skipped", () => {
  const result = buildErrorTurnBilling({
    meteredLlmCalls: [
      meteredCall({ billingStatus: "skipped", skipReason: "byok" }),
      meteredCall({ id: "call_2", billingStatus: "metered", consumedCredits: 2 }),
    ],
    preflightBilling: [],
  });

  assert.equal(result.metadata.billingSkipped, false);
  assert.equal(result.metadata.billingSkipReason, null);
});

test("the finalizer-skipped marker is always set for error turns", () => {
  const result = buildErrorTurnBilling({
    meteredLlmCalls: [meteredCall({ consumedCredits: 1 })],
    preflightBilling: [],
  });

  assert.equal(result.metadata.billingFinalizerSkipped, true);
  assert.equal(result.metadata.billingFinalizerSkipReason, "model_error");
});
