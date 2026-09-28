import assert from "node:assert/strict";
import { test } from "vitest";
import { computeReversalTarget } from "../src/server/payment-reversal";
import { reclaimCredits } from "../src/server/service-helpers";
import { reclaimPages } from "../src/server/page-ledger";
import { createActiveTeamAccount } from "./test-fixtures";

// Pure math and balance-reclaim primitives the payment-reversal service
// (next task) builds on: how many granted units a refund reverses, and how
// those units come back out of a member's own balance.

test("computeReversalTarget is proportional to the refunded fraction, floored", () => {
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 500,
      paidAmount: 1000,
    }),
    10_000,
  );
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 333,
      paidAmount: 1000,
    }),
    6_660,
  );
});

test("computeReversalTarget reverses the full grant once the refunded total reaches the paid amount", () => {
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 1000,
      paidAmount: 1000,
    }),
    20_000,
  );
});

test("computeReversalTarget caps at the full grant for an over-refund", () => {
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 1500,
      paidAmount: 1000,
    }),
    20_000,
  );
});

test("computeReversalTarget is zero when nothing has been refunded", () => {
  assert.equal(
    computeReversalTarget({
      grantedUnits: 20_000,
      refundedTotal: 0,
      paidAmount: 1000,
    }),
    0,
  );
});

test("computeReversalTarget rejects a non-positive paid amount", () => {
  assert.throws(
    () =>
      computeReversalTarget({
        grantedUnits: 20_000,
        refundedTotal: 0,
        paidAmount: 0,
      }),
    { code: "PAYMENT_REVERSAL_INVALID_AMOUNT" },
  );
});

test("reclaimCredits takes from add-on first, then monthly, clamped at the balances", () => {
  const account = createActiveTeamAccount({
    addOnCreditsBalance: 300,
    monthlyCreditsBalance: 500,
  });

  const reclaimed = reclaimCredits(account, 600);

  assert.deepEqual(reclaimed, { fromAddOn: 300, fromMonthly: 300 });
  assert.equal(account.addOnCreditsBalance, 0);
  assert.equal(account.monthlyCreditsBalance, 200);
});

test("reclaimCredits stops at zero when the reclaim exceeds both balances", () => {
  const account = createActiveTeamAccount({
    addOnCreditsBalance: 300,
    monthlyCreditsBalance: 500,
  });

  const reclaimed = reclaimCredits(account, 2000);

  assert.deepEqual(reclaimed, { fromAddOn: 300, fromMonthly: 500 });
  assert.equal(account.addOnCreditsBalance, 0);
  assert.equal(account.monthlyCreditsBalance, 0);
});

test("reclaimPages takes from add-on first, then monthly, clamped at the balances", () => {
  const account = createActiveTeamAccount({
    addOnPagesBalance: 300,
    monthlyPagesBalance: 500,
  });

  const reclaimed = reclaimPages(account, 600);

  assert.deepEqual(reclaimed, { fromAddOn: 300, fromMonthly: 300 });
  assert.equal(account.addOnPagesBalance, 0);
  assert.equal(account.monthlyPagesBalance, 200);
});

test("reclaimPages stops at zero when the reclaim exceeds both balances", () => {
  const account = createActiveTeamAccount({
    addOnPagesBalance: 300,
    monthlyPagesBalance: 500,
  });

  const reclaimed = reclaimPages(account, 2000);

  assert.deepEqual(reclaimed, { fromAddOn: 300, fromMonthly: 500 });
  assert.equal(account.addOnPagesBalance, 0);
  assert.equal(account.monthlyPagesBalance, 0);
});
