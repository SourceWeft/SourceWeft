import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { test } from "vitest";
import { BillingService } from "../src/server/service";
import { PostgresBillingStore } from "../src/server/store";
import type { BillingLedgerRow, BillingOrderState } from "../src/server/types";
import { noopProvider, runtimeConfig } from "./test-fixtures";

function requireBillingTestDatabase() {
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
  return connectionString;
}

/** Asserts a promise rejects on the named Postgres check constraint. */
function rejectsWithConstraint(promise: Promise<unknown>, constraint: string) {
  return assert.rejects(promise, (error: unknown) => {
    const cause = (error as { cause?: { constraint?: string } })?.cause;
    assert.equal(cause?.constraint, constraint);
    return true;
  });
}

test("payment reversal columns, constraints and payment-id lookup", async () => {
  const connectionString = requireBillingTestDatabase();
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
        reversalStatus:
          "bogus" as unknown as BillingOrderState["reversalStatus"],
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
      await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
      await pool.query("delete from billing_orders where id=$1", [order.id]);
    } finally {
      await pool.end();
    }
  }
});

/**
 * Resolves once `promise` settles or a backend named `applicationName` is
 * waiting on a lock, whichever comes first (capped at about two seconds).
 */
async function settledOrWaitingOnLock(
  promise: Promise<unknown>,
  pool: Pool,
  applicationName: string,
) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
    const waiting = await pool.query(
      "select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'",
      [applicationName],
    );
    if (waiting.rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a refund committed while fulfillment fails survives the failure bookkeeping", async () => {
  const connectionString = requireBillingTestDatabase();
  const id = randomUUID();
  const teamId = `billing_test_${id}`;
  const userId = `actor_${id}`;
  const orderId = randomUUID();
  const externalPaymentId = `PAY_${id}`;
  const racerName = `reversal_racer_${id}`;
  const pool = new Pool({ connectionString, max: 4 });
  const racerPool = new Pool({
    connectionString,
    max: 2,
    application_name: racerName,
  });
  const memberships = {
    async listTeamMemberUserIds() {
      return [userId];
    },
    async countTeamMembers() {
      return 1;
    },
    async countPendingTeamInvitations() {
      return 0;
    },
  };

  // The first top-up grant write fails, rolling the fulfillment back. The
  // next order read is the failure bookkeeping's; a refund on another
  // connection races it there, and the read returns only once that refund
  // has committed or is waiting on the order row lock.
  let onFailureRead: (() => Promise<void>) | null = null;
  class FailingGrantStore extends PostgresBillingStore {
    private grantFailuresLeft = 1;
    private armed = false;

    async appendLedger(entry: BillingLedgerRow, client: PoolClient) {
      if (
        entry.feature === "credit_topup_purchase" &&
        this.grantFailuresLeft > 0
      ) {
        this.grantFailuresLeft -= 1;
        this.armed = true;
        throw new Error("ledger unavailable");
      }
      return super.appendLedger(entry, client);
    }

    async getOrderById(orderId: string, client?: PoolClient) {
      const order = await super.getOrderById(orderId, client);
      await this.raceFailureRead();
      return order;
    }

    async getOrderByIdForUpdate(orderId: string, client: PoolClient) {
      const order = await super.getOrderByIdForUpdate(orderId, client);
      await this.raceFailureRead();
      return order;
    }

    private async raceFailureRead() {
      if (this.armed) {
        this.armed = false;
        await onFailureRead?.();
      }
    }
  }

  const store = new FailingGrantStore(pool, memberships);
  const billing = new BillingService(store, runtimeConfig, noopProvider);
  const racer = new BillingService(
    new PostgresBillingStore(racerPool, memberships),
    runtimeConfig,
    noopProvider,
  );
  const refund = () =>
    racer.applyPaymentReversal({
      orderId,
      provider: "waffo",
      reversalId: "refund_1",
      kind: "refund",
      amount: { refundAmount: 1000 },
      paidAmount: 1000,
      currency: "USD",
    });
  let racingRefund = null as ReturnType<typeof refund> | null;
  onFailureRead = async () => {
    racingRefund = refund();
    await settledOrWaitingOnLock(racingRefund, pool, racerName);
  };
  const now = new Date().toISOString();

  try {
    await billing.ensureBillingAccount(teamId, userId);
    const addOnBefore = (await store.getAccount(teamId, userId))!
      .addOnCreditsBalance;
    await store.insertOrder({
      id: orderId,
      provider: "waffo",
      kind: "credit_topup",
      status: "payment_confirmed",
      paymentStatus: "paid",
      userId,
      teamId,
      clientReferenceKey: null,
      planFamily: null,
      billingInterval: null,
      quantity: 2,
      unitType: "credit",
      unitAmount: 10_000,
      grantedCredits: 20_000,
      grantedPages: 0,
      refundedAmount: 0,
      reversedUnits: 0,
      reversalStatus: "none",
      externalCheckoutId: null,
      externalPaymentId: null,
      externalCustomerId: null,
      externalSubscriptionId: null,
      externalProductId: "prod_credit_topup",
      amountTotal: 1000,
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
    });

    await assert.rejects(
      () => billing.fulfillOrder({ orderId, externalPaymentId }),
      /ledger unavailable/,
    );
    assert.ok(racingRefund, "the refund raced the failure bookkeeping");
    assert.equal((await racingRefund)?.outcome, "recorded_before_fulfillment");

    const failed = await store.getOrderById(orderId);
    assert.equal(failed?.status, "fulfillment_failed");
    assert.equal(failed?.externalPaymentId, externalPaymentId);
    assert.equal(failed?.refundedAmount, 1000);
    assert.equal(failed?.reversalStatus, "refunded");

    // The retry job's fulfillment grants and immediately reverses: net zero.
    await billing.fulfillOrder({ orderId, externalPaymentId });
    const fulfilled = await store.getOrderById(orderId);
    assert.equal(fulfilled?.status, "fulfilled");
    assert.equal(fulfilled?.reversedUnits, 20_000);
    assert.equal(
      (await store.getAccount(teamId, userId))?.addOnCreditsBalance,
      addOnBefore,
    );
    assert.deepEqual(await refund(), { outcome: "duplicate" });
  } finally {
    try {
      await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
      await pool.query("delete from billing_orders where id=$1", [orderId]);
      await pool.query("delete from billing_accounts where team_id=$1", [
        teamId,
      ]);
    } finally {
      await Promise.all([pool.end(), racerPool.end()]);
    }
  }
});
