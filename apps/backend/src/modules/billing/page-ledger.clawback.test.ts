import assert from "node:assert/strict";
import { test } from "vitest";
import { clawbackMonthlyPages } from "./page-ledger";
import type { BillingAccountState } from "./types";

// Direct unit tests for the seat-downgrade clawback primitive. Unlike
// `page-ledger.test.ts`, which exercises the ledger through the services'
// public API, these pin the primitive's boundary semantics — clamping, the
// no-op on non-positive balances, and which fields it may touch — so the
// behavior inlined in `applySeatQuotaClawbackLocked` before extraction stays
// verbatim.

function createAccount(
  overrides: Partial<BillingAccountState> = {},
): BillingAccountState {
  const now = new Date().toISOString();

  return {
    teamId: "team_1",
    userId: "user_1",
    planFamily: "team_standard",
    cycleAnchorAt: now,
    cycleSource: "provider_subscription",
    cycleStartAt: now,
    cycleEndAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    pagesLimit: 12_000,
    pagesUsed: 40,
    monthlyPagesGrant: 12_000,
    monthlyPagesBalance: 11_960,
    addOnPagesBalance: 250,
    pagesConsumedThisCycle: 40,
    monthlyCreditsGrant: 40_000,
    monthlyCreditsBalance: 40_000,
    addOnCreditsBalance: 0,
    creditsReserved: 0,
    creditsConsumedThisCycle: 0,
    seatCount: 2,
    spendSoftCapUsd: null,
    spendHardCapUsd: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("clawbackMonthlyPages debits the full amount when the balance covers it", () => {
  const account = createAccount({ monthlyPagesBalance: 300 });

  const clawedBack = clawbackMonthlyPages(account, 120);

  assert.equal(clawedBack, 120);
  assert.equal(account.monthlyPagesBalance, 180);
});

test("clawbackMonthlyPages clamps to the balance and never goes negative", () => {
  const account = createAccount({ monthlyPagesBalance: 100 });

  const clawedBack = clawbackMonthlyPages(account, 250);

  assert.equal(clawedBack, 100);
  assert.equal(account.monthlyPagesBalance, 0);
});

test("clawbackMonthlyPages is a no-op on a zero balance", () => {
  const account = createAccount({ monthlyPagesBalance: 0 });

  const clawedBack = clawbackMonthlyPages(account, 50);

  assert.equal(clawedBack, 0);
  assert.equal(account.monthlyPagesBalance, 0);
});

test("clawbackMonthlyPages leaves an already-negative balance untouched", () => {
  const account = createAccount({ monthlyPagesBalance: -25 });

  const clawedBack = clawbackMonthlyPages(account, 50);

  // The clamp returns the (negative) balance and the >0 guard skips the
  // debit, so the bucket is never *increased* by clawing back a negative.
  assert.equal(clawedBack, -25);
  assert.equal(account.monthlyPagesBalance, -25);
});

test("clawbackMonthlyPages is a no-op for a non-positive clawback amount", () => {
  const account = createAccount({ monthlyPagesBalance: 400 });

  assert.equal(clawbackMonthlyPages(account, 0), 0);
  assert.equal(account.monthlyPagesBalance, 400);
});

test("clawbackMonthlyPages touches neither the add-on bucket, the cycle counters, nor the mirrors", () => {
  const account = createAccount({
    monthlyPagesBalance: 500,
    addOnPagesBalance: 77,
    monthlyPagesGrant: 12_000,
    pagesConsumedThisCycle: 40,
    pagesLimit: 12_000,
    pagesUsed: 40,
  });

  clawbackMonthlyPages(account, 200);

  assert.equal(account.monthlyPagesBalance, 300);
  assert.equal(account.addOnPagesBalance, 77);
  assert.equal(account.monthlyPagesGrant, 12_000);
  assert.equal(account.pagesConsumedThisCycle, 40);
  assert.equal(account.pagesLimit, 12_000);
  assert.equal(account.pagesUsed, 40);
});
