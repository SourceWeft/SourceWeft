import type { BillingStore } from "./store-port";
import type { BillingOrderState } from "./types";

/**
 * Read-modify-write of one order under its row lock. A payment reversal can
 * commit `refundedAmount` / `reversedUnits` / `reversalStatus` (and
 * `metadata.reversalPaidAmount`) on the row between an unlocked read and a
 * later whole-row write; writing that stale read back would erase the
 * reversal columns. Any order write that does not already hold the row lock
 * in its own transaction should route through here: it always re-reads the
 * row inside `store.getOrderByIdForUpdate` and merges in only the fields
 * `apply` changes.
 *
 * `apply` sees the freshly locked row, so any guard that compares against
 * current state (e.g. "only transition if still unpaid") belongs inside it,
 * returning `null` to signal no-op. A no-op never writes and never bumps
 * `updatedAt`. A missing order returns `null` without calling `apply`.
 */
export async function updateOrderLocked(
  store: BillingStore,
  orderId: string,
  apply: (current: BillingOrderState) => Partial<BillingOrderState> | null,
): Promise<BillingOrderState | null> {
  return store.runInTransaction(async (client) => {
    const current = await store.getOrderByIdForUpdate(orderId, client);
    if (!current) return null;
    const changes = apply(current);
    if (!changes) return current;
    return store.updateOrder(
      { ...current, ...changes, updatedAt: new Date().toISOString() },
      client,
    );
  });
}
