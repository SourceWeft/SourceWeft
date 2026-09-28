import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test } from "vitest";
import { PostgresBillingStore } from "../src/server/store";
import type { BillingLedgerRow, BillingOrderState } from "../src/server/types";

/** Asserts a promise rejects on the named Postgres check constraint. */
function rejectsWithConstraint(promise: Promise<unknown>, constraint: string) {
  return assert.rejects(promise, (error: unknown) => {
    const cause = (error as { cause?: { constraint?: string } })?.cause;
    assert.equal(cause?.constraint, constraint);
    return true;
  });
}

test("payment reversal columns, constraints and payment-id lookup", async () => {
  const connectionString = process.env.DATABASE_URL;
  if (
    !connectionString ||
    !/^\/sourceweft_billing_test(?:_|$)/.test(
      new URL(connectionString).pathname,
    )
  ) {
    throw new Error(
      "Use an isolated sourceweft_billing_test database with the existing migrations applied",
    );
  }
  const pool = new Pool({ connectionString, max: 4 });
  const memberships = {
    async listTeamMemberUserIds() {
      throw new Error("Unexpected membership lookup");
    },
    async countTeamMembers() {
      throw new Error("Unexpected member count");
    },
    async countPendingTeamInvitations() {
      throw new Error("Unexpected invitation count");
    },
  };
  const store = new PostgresBillingStore(pool, memberships);
  const teamId = `billing_test_${randomUUID()}`;
  const userId = `actor_${randomUUID()}`;
  const externalPaymentId = `PAY_${randomUUID()}`;
  const now = new Date().toISOString();

  const order: BillingOrderState = {
    id: randomUUID(),
    provider: "waffo",
    kind: "credit_topup",
    status: "fulfilled",
    paymentStatus: "paid",
    userId,
    teamId,
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
    externalCheckoutId: null,
    externalPaymentId,
    externalCustomerId: null,
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
    fulfilledAt: now,
    expiresAt: null,
    fulfillmentAttemptCount: 1,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const inserted = await store.insertOrder(order);
    assert.equal(inserted.refundedAmount, 0);
    assert.equal(inserted.reversedUnits, 0);
    assert.equal(inserted.reversalStatus, "none");

    const found = await store.getOrderByProviderPaymentId(
      "waffo",
      externalPaymentId,
    );
    assert.ok(found);
    assert.equal(found?.id, order.id);
    assert.equal(found?.refundedAmount, 0);
    assert.equal(found?.reversedUnits, 0);
    assert.equal(found?.reversalStatus, "none");

    await rejectsWithConstraint(
      store.updateOrder({
        ...inserted,
        reversalStatus: "bogus" as unknown as BillingOrderState["reversalStatus"],
        updatedAt: new Date().toISOString(),
      }),
      "billing_orders_reversal_status_check",
    );

    await rejectsWithConstraint(
      store.updateOrder({
        ...inserted,
        reversedUnits: inserted.grantedCredits + inserted.grantedPages + 1,
        updatedAt: new Date().toISOString(),
      }),
      "billing_orders_reversed_units_check",
    );

    const ledgerEntry: BillingLedgerRow = {
      id: randomUUID(),
      teamId,
      workspaceId: null,
      actorUserId: userId,
      feature: "credit_topup_purchase",
      eventType: "refund",
      unitType: "credit",
      delta: -inserted.grantedCredits,
      balanceAfter: 0,
      referenceId: order.id,
      idempotencyKey: `billing-order:${order.id}:reversal`,
      operationId: `billing-order:${order.id}:reversal`,
      operationType: "payment_reversal",
      activityVisible: true,
      activityTitle: "Payment reversed",
      activitySummary: "-10000 credits",
      metadata: { orderId: order.id },
      createdAt: new Date().toISOString(),
    };
    await store.runInTransaction(async (client) => {
      await store.appendLedger(ledgerEntry, client);
    });

    const ledgerRows = await pool.query(
      "select operation_type from usage_ledgers where id=$1",
      [ledgerEntry.id],
    );
    assert.equal(ledgerRows.rows[0]?.operation_type, "payment_reversal");
  } finally {
    try {
      await pool.query("delete from usage_ledgers where team_id=$1", [
        teamId,
      ]);
      await pool.query("delete from billing_orders where id=$1", [order.id]);
    } finally {
      await pool.end();
    }
  }
});
