import type { BillingMode } from "@sourceweft/credits-core";
import { BillingError } from "./errors";
import type { BillingAccountState } from "./types";

/**
 * The page ledger: every rule for how a member's ingestion-page balance moves.
 *
 * Pages live in two buckets on the per-member account row (`teamId`,`userId`):
 * a monthly bucket that expires and regrants at each cycle boundary, and an
 * add-on bucket (top-ups, shadow overage) that carries over. Consumption drains
 * monthly first, then add-on. This file is the one place those semantics are
 * written down — as pure state transitions on `BillingAccountState` plus one
 * pure admission decision. Nothing here talks to the store, appends ledger
 * rows, or knows about transactions: callers (`usage-service` for settlement,
 * `account-service` for cycle lifecycle, the purchase-flow services for top-up
 * grants and seat clawbacks) run these transitions inside their locked
 * transaction and record the matching ledger entries themselves, which is
 * what keeps `page-ledger.test.ts` green through the services' public API.
 *
 * `pagesLimit`/`pagesUsed` are legacy mirror fields kept in sync with
 * `monthlyPagesGrant`/`pagesConsumedThisCycle`; `syncPageMirrorFields` is the
 * only writer of that pairing.
 */

/** Total pages on the row across both buckets, before any availability floor. */
export function getTotalPagesBalance(account: BillingAccountState) {
  return account.monthlyPagesBalance + account.addOnPagesBalance;
}

/** Pages a member may still consume. Floored at zero for display and admission. */
export function getAvailablePages(account: BillingAccountState) {
  return Math.max(getTotalPagesBalance(account), 0);
}

/**
 * Drains `pagesToConsume` from the buckets, monthly first, then add-on.
 * Callers must have admitted the amount first (`decidePageAdmission`); running
 * out here means the admission invariant was violated, so it fails loudly.
 */
function spendPages(account: BillingAccountState, pagesToConsume: number) {
  let remaining = pagesToConsume;

  if (account.monthlyPagesBalance > 0) {
    const fromMonthly = Math.min(account.monthlyPagesBalance, remaining);
    account.monthlyPagesBalance -= fromMonthly;
    remaining -= fromMonthly;
  }

  if (remaining > 0 && account.addOnPagesBalance > 0) {
    const fromAddOn = Math.min(account.addOnPagesBalance, remaining);
    account.addOnPagesBalance -= fromAddOn;
    remaining -= fromAddOn;
  }

  if (remaining > 0) {
    throw new BillingError(
      "INSUFFICIENT_PAGES_INTERNAL",
      500,
      "Unable to allocate page buckets for consumption",
    );
  }
}

/**
 * The full deduction transition for one admitted ingestion: drain the buckets,
 * count the pages against this cycle, and refresh the legacy mirror fields.
 */
export function consumePages(
  account: BillingAccountState,
  pagesToConsume: number,
) {
  spendPages(account, pagesToConsume);
  account.pagesConsumedThisCycle += pagesToConsume;
  syncPageMirrorFields(account);
}

export type PageAdmissionDecision =
  | { outcome: "admit" }
  | { outcome: "reject" }
  | { outcome: "shadow_grant"; missingPages: number };

/**
 * Quota admission for one ingestion request. Enough balance always admits.
 * A shortfall rejects only when billing is enforced AND limits are enforced;
 * every other mode covers the shortfall with a shadow add-on grant so usage
 * keeps flowing while the ledger still records the overage.
 */
export function decidePageAdmission(input: {
  availablePages: number;
  pagesToConsume: number;
  mode: BillingMode;
  enforceLimits: boolean;
}): PageAdmissionDecision {
  if (input.availablePages >= input.pagesToConsume) {
    return { outcome: "admit" };
  }

  if (input.mode === "enforced" && input.enforceLimits) {
    return { outcome: "reject" };
  }

  return {
    outcome: "shadow_grant",
    missingPages: input.pagesToConsume - input.availablePages,
  };
}

/** Adds pages to the carry-over bucket (top-up purchases, shadow overage). */
export function grantAddOnPages(account: BillingAccountState, pages: number) {
  account.addOnPagesBalance += pages;
}

/** Adds a mid-cycle quota increase (plan/seat change delta) to the monthly bucket. */
export function grantMonthlyPages(account: BillingAccountState, pages: number) {
  account.monthlyPagesBalance += pages;
}

/**
 * Debits a mid-cycle quota decrease (seat-downgrade clawback) from the monthly
 * bucket, clamped to the current balance so the debit never pushes the bucket
 * negative — a bucket already at or below zero claws back nothing. Cycle
 * counters and the legacy mirrors stay untouched: clawed-back pages were
 * granted, not consumed. Returns the clamped amount for the caller's adjust
 * ledger row; a non-positive return means nothing moved.
 */
export function clawbackMonthlyPages(
  account: BillingAccountState,
  pages: number,
) {
  const pagesToClawback = Math.min(account.monthlyPagesBalance, pages);
  if (pagesToClawback > 0) {
    account.monthlyPagesBalance -= pagesToClawback;
  }
  return pagesToClawback;
}

/**
 * Zeroes the expiring monthly bucket at a cycle boundary — add-on pages carry
 * over untouched. Returns the expired amount for the caller's expire ledger row.
 */
export function expireMonthlyPages(account: BillingAccountState) {
  const expiredPages = account.monthlyPagesBalance;
  account.monthlyPagesBalance = 0;
  return expiredPages;
}

/** Sets the monthly bucket to the new cycle's per-seat quota (never additive). */
export function regrantMonthlyPages(
  account: BillingAccountState,
  monthlyPagesLimit: number,
) {
  account.monthlyPagesBalance = monthlyPagesLimit;
}

/**
 * Resets the per-cycle page counters for a new cycle: the grant becomes the
 * plan's per-seat quota and consumption starts from zero, mirrors included.
 */
export function resetPageCycleCounters(
  account: BillingAccountState,
  monthlyPagesLimit: number,
) {
  account.monthlyPagesGrant = monthlyPagesLimit;
  account.pagesConsumedThisCycle = 0;
  syncPageMirrorFields(account);
}

/** Refreshes the legacy `pagesLimit`/`pagesUsed` mirrors from their sources of truth. */
export function syncPageMirrorFields(account: BillingAccountState) {
  account.pagesLimit = account.monthlyPagesGrant;
  account.pagesUsed = account.pagesConsumedThisCycle;
}
