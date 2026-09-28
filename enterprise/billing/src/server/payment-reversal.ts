import { BillingError } from "./errors";

/**
 * The proportional-refund formula for a payment reversal: how many of the
 * units a top-up order granted should now be reversed, given the amount
 * refunded so far against what was originally paid.
 *
 * Once `refundedTotal` reaches (or, for an over-refund, exceeds) `paidAmount`
 * the target is the full grant. Otherwise it is the same fraction of the
 * grant that has been refunded, floored to a whole unit — the caller
 * (`applyPaymentReversal`, next task) diffs this against the order's
 * `reversed_units` to get the delta still owed back.
 */
export function computeReversalTarget(input: {
  grantedUnits: number;
  refundedTotal: number;
  paidAmount: number;
}): number {
  if (input.paidAmount <= 0) {
    throw new BillingError(
      "PAYMENT_REVERSAL_INVALID_AMOUNT",
      422,
      "paidAmount must be greater than zero",
    );
  }

  if (input.refundedTotal >= input.paidAmount) {
    return input.grantedUnits;
  }

  return Math.floor(
    (input.grantedUnits * input.refundedTotal) / input.paidAmount,
  );
}
