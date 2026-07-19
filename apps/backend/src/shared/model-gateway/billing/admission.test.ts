import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../../modules/content/billing-port";
import { billingAdmission } from "./admission";

function billingWith(billingMode: string, available: number): ContentBillingPort {
  return {
    getSummary: vi.fn(
      async (teamId: string) =>
        ({
          teamId,
          billingMode,
          credits: { available, consumedThisCycle: 0 },
        }) as unknown as BillingSummaryResponse,
    ),
    meterConsume: vi.fn(),
    meterIngestion: vi.fn(),
  } as unknown as ContentBillingPort;
}

const scope = { teamId: "team_1", feature: "chat", scopeId: "trace_1" };

test("enforced mode denies a team with no credits", async () => {
  const decision = await billingAdmission.admit({
    billing: billingWith("enforced", 0),
    ...scope,
  });

  assert.equal(decision.allowed, false);
  assert.equal(
    decision.allowed === false ? decision.reason : null,
    "insufficient_credits",
  );
});

test("enforced mode admits a team with credits", async () => {
  const decision = await billingAdmission.admit({
    billing: billingWith("enforced", 25),
    ...scope,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.availableCredits, 25);
});

// Shadow and disabled are observation-only modes; they auto-grant shortfalls
// further down the stack, so gating them here would break non-billing installs.
test("shadow mode admits even at zero credits", async () => {
  const decision = await billingAdmission.admit({
    billing: billingWith("shadow", 0),
    ...scope,
  });

  assert.equal(decision.allowed, true);
});

test("disabled mode admits even at negative credits", async () => {
  const decision = await billingAdmission.admit({
    billing: billingWith("disabled", -10),
    ...scope,
  });

  assert.equal(decision.allowed, true);
});
