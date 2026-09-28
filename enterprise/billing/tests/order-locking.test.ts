import assert from "node:assert/strict";
import { test } from "vitest";
import { updateOrderLocked } from "../src/server/order-locking";
import type { BillingOrderState } from "../src/server/types";
import { MemoryBillingStore } from "./test-fixtures";

function order(overrides: Partial<BillingOrderState> = {}): BillingOrderState {
  const now = "2026-09-28T00:00:00.000Z";
  return {
    id: "order_1",
    provider: "stripe",
    kind: "credit_topup",
    status: "payment_confirmed",
    paymentStatus: "paid",
    userId: "user_1",
    teamId: "team_1",
    clientReferenceKey: null,
    planFamily: null,
    billingInterval: null,
    quantity: 1,
    unitType: "credit",
    unitAmount: 10_000,
    grantedCredits: 10_000,
    grantedPages: 0,
    refundedAmount: 0,
    reversedUnits: 0,
    reversalStatus: "none",
    externalCheckoutId: "checkout_1",
    externalPaymentId: "pay_1",
    externalCustomerId: "cus_1",
    externalSubscriptionId: null,
    externalProductId: "prod_credit_topup",
    amountTotal: 1250,
    currency: "USD",
    successUrl: null,
    cancelUrl: null,
    metadata: {},
    errorCode: null,
    errorMessage: null,
    paidAt: now,
    fulfilledAt: null,
    expiresAt: null,
    fulfillmentAttemptCount: 0,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * A store whose unlocked `getOrderById` still serves a stale, pre-reversal
 * snapshot while the row itself -- what `getOrderByIdForUpdate` reads under
 * lock -- already carries the reversal columns. This is what a real,
 * concurrently committed refund looks like to any reader that is not
 * holding the row lock: proves `updateOrderLocked` reads through the locked
 * accessor, not the unlocked one.
 */
class StaleUnlockedReadStore extends MemoryBillingStore {
  override async getOrderById() {
    return this.order ? order({ ...this.order, refundedAmount: 0 }) : null;
  }
}

class CountingUpdateStore extends MemoryBillingStore {
  updateOrderCalls = 0;
  override async updateOrder(
    ...args: Parameters<MemoryBillingStore["updateOrder"]>
  ): ReturnType<MemoryBillingStore["updateOrder"]> {
    this.updateOrderCalls += 1;
    return super.updateOrder(...args);
  }
}

test("applies changes on top of the freshly locked row", async () => {
  const store = new StaleUnlockedReadStore();
  store.order = order({ refundedAmount: 700, status: "payment_confirmed" });

  const result = await updateOrderLocked(store, "order_1", () => ({
    status: "payment_failed",
  }));

  assert.equal(result?.status, "payment_failed");
  assert.equal(result?.refundedAmount, 700);
  assert.equal(store.order?.refundedAmount, 700);
});

test("a null result writes nothing", async () => {
  const store = new CountingUpdateStore();
  store.order = order({ updatedAt: "2026-01-01T00:00:00.000Z" });

  const result = await updateOrderLocked(store, "order_1", () => null);

  assert.equal(store.updateOrderCalls, 0);
  assert.equal(result?.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(store.order?.updatedAt, "2026-01-01T00:00:00.000Z");
});

test("a missing order returns null without calling apply or writing", async () => {
  const store = new CountingUpdateStore();
  store.order = null;
  let applyCalls = 0;

  const result = await updateOrderLocked(store, "missing_order", () => {
    applyCalls += 1;
    return { status: "payment_failed" };
  });

  assert.equal(result, null);
  assert.equal(applyCalls, 0);
  assert.equal(store.updateOrderCalls, 0);
});
