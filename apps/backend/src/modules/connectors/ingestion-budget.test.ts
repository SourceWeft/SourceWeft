import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ContentBillingPort } from "../content/billing-port";
import { IngestionPageBudget, isPagesLimitExceeded } from "./ingestion-budget";

function port(
  states: Array<
    | { kind: "unmetered" }
    | { available: number; cycleCapacity: number; enforced?: boolean }
  >,
) {
  const getExecutionState = vi.fn(async () => {
    const next = states.length > 1 ? states.shift()! : states[0]!;
    if ("kind" in next) {
      return { kind: "unmetered" as const, reason: "billing_not_installed" };
    }
    return {
      kind: "metered" as const,
      mode: "enforced" as const,
      availableCredits: 0,
      consumedThisCycle: 0,
      ingestionPages: { enforced: true, ...next },
    };
  });
  return {
    billing: { getExecutionState } as unknown as ContentBillingPort,
    getExecutionState,
  };
}

test("reads admission once and tracks consumption locally while pages fit", async () => {
  const { billing, getExecutionState } = port([
    { available: 5, cycleCapacity: 10 },
  ]);
  const budget = new IngestionPageBudget(billing, "team", "owner");
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await budget.admit(1), { outcome: "admit" });
    budget.consumed(1);
  }
  assert.equal(getExecutionState.mock.calls.length, 1);
  assert.deepEqual(getExecutionState.mock.calls[0], ["team", "owner"]);
});

test("re-reads before refusing, so a mid-run top-up is honoured", async () => {
  const { billing, getExecutionState } = port([
    { available: 1, cycleCapacity: 10 },
    { available: 8, cycleCapacity: 10 },
  ]);
  const budget = new IngestionPageBudget(billing, "team", "owner");
  assert.deepEqual(await budget.admit(3), { outcome: "admit" });
  assert.equal(getExecutionState.mock.calls.length, 2);
});

test("distinguishes waiting for pages from an item no cycle can admit", async () => {
  const { billing } = port([{ available: 2, cycleCapacity: 10 }]);
  const budget = new IngestionPageBudget(billing, "team", "owner");
  assert.deepEqual(await budget.admit(4), {
    outcome: "insufficient",
    requested: 4,
    available: 2,
  });
  assert.deepEqual(await budget.admit(11), {
    outcome: "oversized",
    requested: 11,
    cycleCapacity: 10,
  });
});

test("never refuses when settlement would not reject", async () => {
  const unmetered = new IngestionPageBudget(
    port([{ kind: "unmetered" }]).billing,
    "team",
    "owner",
  );
  assert.deepEqual(await unmetered.admit(1_000), { outcome: "admit" });
  const shadow = new IngestionPageBudget(
    port([{ available: 0, cycleCapacity: 0, enforced: false }]).billing,
    "team",
    "owner",
  );
  assert.deepEqual(await shadow.admit(1_000), { outcome: "admit" });
});

test("recognises only the settlement page-limit rejection", () => {
  assert.equal(isPagesLimitExceeded({ code: "PAGES_LIMIT_EXCEEDED" }), true);
  assert.equal(isPagesLimitExceeded({ code: "CREDITS_EXHAUSTED" }), false);
  assert.equal(isPagesLimitExceeded(new Error("PAGES_LIMIT_EXCEEDED")), false);
});
