import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { test } from "vitest";
import { updateOrderLocked } from "../src/server/order-locking";
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

test("checkout recovery's locked write keeps a reversal committed in between", async () => {
  const connectionString = requireBillingTestDatabase();
  const id = randomUUID();
  const teamId = `billing_test_${id}`;
  const userId = `actor_${id}`;
  const orderId = randomUUID();
  const racerName = `checkout_recovery_racer_${id}`;
  const pool = new Pool({ connectionString, max: 4 });
  const racerPool = new Pool({
    connectionString,
    max: 2,
    application_name: racerName,
  });
  const memberships = noThrowingMemberships(userId);

  // `updateOrderLocked` — the write Stripe checkout recovery (and the
  // expiry write) uses — holds the order row lock inside its own
  // transaction from `getOrderByIdForUpdate` through its commit. While it
  // still holds that lock, a reversal is attempted on a separate
  // connection: it can only proceed once the recovery transaction commits
  // and releases the lock, at which point its own locked read sees the
  // just-recovered row fresh and layers its reversal columns on top,
  // rather than clobbering them with data read before the recovery.
  let onLockedRead: (() => Promise<void>) | null = null;
  class RecoveryRaceStore extends PostgresBillingStore {
    private armed = true;
    override async getOrderByIdForUpdate(
      targetOrderId: string,
      client: PoolClient,
    ) {
      const order = await super.getOrderByIdForUpdate(targetOrderId, client);
      if (this.armed && order?.id === orderId) {
        this.armed = false;
        await onLockedRead?.();
      }
      return order;
    }
  }

  const store = new RecoveryRaceStore(pool, memberships);
  const racerStore = new PostgresBillingStore(racerPool, memberships);
  const racerBilling = new BillingService(
    racerStore,
    runtimeConfig,
    noopProvider,
  );
  const recordReversal = () =>
    racerBilling.applyPaymentReversal({
      orderId,
      provider: "stripe",
      reversalId: "race_refund",
      kind: "refund",
      amount: { refundedTotal: 625 },
      paidAmount: 1250,
      currency: "usd",
    });
  let racingReversal = null as ReturnType<typeof recordReversal> | null;
  onLockedRead = async () => {
    racingReversal = recordReversal();
    await settledOrWaitingOnLock(racingReversal, pool, racerName);
  };

  const now = new Date().toISOString();

  try {
    const billing = new BillingService(store, runtimeConfig, noopProvider);
    await billing.ensureBillingAccount(teamId, userId);
    await store.insertOrder({
      id: orderId,
      provider: "stripe",
      kind: "credit_topup",
      status: "checkout_created",
      paymentStatus: "unpaid",
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
      externalPaymentId: null,
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
      paidAt: null,
      fulfilledAt: null,
      expiresAt: null,
      fulfillmentAttemptCount: 0,
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // The write checkout recovery performs: only `externalCheckoutId`
    // changes; everything else, including any reversal columns committed
    // in the meantime, is re-read fresh inside the lock.
    const recovered = await updateOrderLocked(store, orderId, () => ({
      externalCheckoutId: "cs_recovered",
    }));
    assert.equal(recovered?.externalCheckoutId, "cs_recovered");

    assert.ok(racingReversal, "the reversal raced the recovery write");
    const reversalResult = await racingReversal;
    // The order was never fulfilled, so the reversal only records itself
    // on the order for fulfillment to apply later.
    assert.equal(reversalResult?.outcome, "recorded_before_fulfillment");

    const final = await store.getOrderById(orderId);
    assert.equal(final?.externalCheckoutId, "cs_recovered");
    assert.equal(final?.refundedAmount, 625);
    assert.equal(final?.reversedUnits, 0);
    assert.equal(final?.reversalStatus, "partially_refunded");
    assert.equal(final?.metadata.reversalPaidAmount, 1250);
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
}, 30_000);

function noThrowingMemberships(userId: string) {
  return {
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
}

/** A fulfilled single-unit credit top-up order, inserted `payment_confirmed`
 * and then fulfilled through the real service path so the grant lands on the
 * account through the same code the racing test above exercises. */
async function insertAndFulfillCreditTopup(
  billing: BillingService,
  store: PostgresBillingStore,
  input: {
    orderId: string;
    teamId: string;
    userId: string;
    externalPaymentId: string;
    quantity: number;
    grantedCredits: number;
    amountTotal: number;
  },
) {
  const now = new Date().toISOString();
  await store.insertOrder({
    id: input.orderId,
    provider: "waffo",
    kind: "credit_topup",
    status: "payment_confirmed",
    paymentStatus: "paid",
    userId: input.userId,
    teamId: input.teamId,
    clientReferenceKey: null,
    planFamily: null,
    billingInterval: null,
    quantity: input.quantity,
    unitType: "credit",
    unitAmount: 10_000,
    grantedCredits: input.grantedCredits,
    grantedPages: 0,
    refundedAmount: 0,
    reversedUnits: 0,
    reversalStatus: "none",
    externalCheckoutId: null,
    externalPaymentId: null,
    externalCustomerId: null,
    externalSubscriptionId: null,
    externalProductId: "prod_credit_topup",
    amountTotal: input.amountTotal,
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
  await billing.fulfillOrder({
    orderId: input.orderId,
    externalPaymentId: input.externalPaymentId,
  });
}

test("concurrent duplicate deliveries debit once", async () => {
  const connectionString = requireBillingTestDatabase();
  const pool = new Pool({ connectionString, max: 4 });
  const id = randomUUID();
  const teamId = `billing_test_${id}`;
  const userId = `actor_${id}`;
  const orderId = randomUUID();
  const externalPaymentId = `PAY_${id}`;
  const store = new PostgresBillingStore(pool, noThrowingMemberships(userId));
  const billing = new BillingService(store, runtimeConfig, noopProvider);

  try {
    await billing.ensureBillingAccount(teamId, userId);
    await insertAndFulfillCreditTopup(billing, store, {
      orderId,
      teamId,
      userId,
      externalPaymentId,
      quantity: 2,
      grantedCredits: 20_000,
      amountTotal: 1000,
    });
    const addOnBefore = (await store.getAccount(teamId, userId))
      ?.addOnCreditsBalance;
    assert.equal(addOnBefore, 20_000);

    // The same provider webhook redelivered: two calls race with the same
    // reversalId, on separate connections from the same pool.
    const redeliveredRefund = () =>
      billing.applyPaymentReversal({
        orderId,
        provider: "waffo",
        reversalId: "redelivered_refund",
        kind: "refund",
        amount: { refundedTotal: 1000 },
        paidAmount: 1000,
        currency: "USD",
      });
    const [first, second] = await Promise.all([
      redeliveredRefund(),
      redeliveredRefund(),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    assert.deepEqual(outcomes, ["applied", "duplicate"]);

    const ledgerRows = await pool.query(
      "select count(*)::int as count from usage_ledgers where team_id=$1 and reference_id=$2 and operation_type='payment_reversal'",
      [teamId, orderId],
    );
    assert.equal(ledgerRows.rows[0]?.count, 1);

    const account = await store.getAccount(teamId, userId);
    assert.equal(account?.addOnCreditsBalance, 0);
  } finally {
    try {
      await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
      await pool.query("delete from billing_orders where id=$1", [orderId]);
      await pool.query("delete from billing_accounts where team_id=$1", [
        teamId,
      ]);
    } finally {
      await pool.end();
    }
  }
});

test("reversal and usage on the same member serialize", async () => {
  const connectionString = requireBillingTestDatabase();
  const pool = new Pool({ connectionString, max: 4 });
  const id = randomUUID();
  const teamId = `billing_test_${id}`;
  const userId = `actor_${id}`;
  const orderId = randomUUID();
  const externalPaymentId = `PAY_${id}`;
  const store = new PostgresBillingStore(pool, noThrowingMemberships(userId));
  const billing = new BillingService(store, runtimeConfig, noopProvider);

  try {
    await billing.ensureBillingAccount(teamId, userId);
    await insertAndFulfillCreditTopup(billing, store, {
      orderId,
      teamId,
      userId,
      externalPaymentId,
      quantity: 1,
      grantedCredits: 10_000,
      amountTotal: 1250,
    });
    const before = await store.getAccount(teamId, userId);
    assert.equal(before?.addOnCreditsBalance, 10_000);
    assert.equal(
      before?.monthlyCreditsBalance,
      runtimeConfig.defaultMonthlyCredits,
    );

    // A partial refund (half of `paidAmount`) reclaims 5,000 of the 10,000
    // add-on grant; the concurrent usage charge spends 2,000 credits, well
    // within the 3,000 monthly grant. The two touch disjoint buckets, so the
    // "serial" result — running either order — is the same fixed numbers;
    // this only proves the account row's lock actually serializes the two
    // read-modify-writes instead of one clobbering the other.
    const [reversal, consume] = await Promise.all([
      billing.applyPaymentReversal({
        orderId,
        provider: "waffo",
        reversalId: "partial_refund",
        kind: "refund",
        amount: { refundedTotal: 625 },
        paidAmount: 1250,
        currency: "USD",
      }),
      billing.meterConsume(
        teamId,
        { credits: 2000, feature: "test", idempotencyKey: `consume_${id}` },
        userId,
      ),
    ]);

    assert.equal(reversal.outcome, "applied");
    if (reversal.outcome === "applied") {
      assert.equal(reversal.deltaUnits, 5_000);
      assert.equal(reversal.recovered, 5_000);
      assert.equal(reversal.shortfall, 0);
    }
    assert.equal(consume.consumedCredits, 2000);

    const after = await store.getAccount(teamId, userId);
    assert.equal(after?.addOnCreditsBalance, 5_000);
    assert.equal(
      after?.monthlyCreditsBalance,
      runtimeConfig.defaultMonthlyCredits - 2000,
    );

    const row = await pool.query(
      "select add_on_credits_balance, monthly_credits_balance from billing_accounts where team_id=$1 and user_id=$2",
      [teamId, userId],
    );
    assert.equal(row.rows[0]?.add_on_credits_balance, 5_000);
    assert.equal(
      row.rows[0]?.monthly_credits_balance,
      runtimeConfig.defaultMonthlyCredits - 2000,
    );
  } finally {
    try {
      await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
      await pool.query("delete from billing_orders where id=$1", [orderId]);
      await pool.query("delete from billing_accounts where team_id=$1", [
        teamId,
      ]);
    } finally {
      await pool.end();
    }
  }
});

test("reclaim stops at zero under real constraints", async () => {
  const connectionString = requireBillingTestDatabase();
  const pool = new Pool({ connectionString, max: 4 });
  const id = randomUUID();
  const teamId = `billing_test_${id}`;
  const userId = `actor_${id}`;
  const orderId = randomUUID();
  const externalPaymentId = `PAY_${id}`;
  const store = new PostgresBillingStore(pool, noThrowingMemberships(userId));
  const billing = new BillingService(store, runtimeConfig, noopProvider);

  try {
    await billing.ensureBillingAccount(teamId, userId);
    await insertAndFulfillCreditTopup(billing, store, {
      orderId,
      teamId,
      userId,
      externalPaymentId,
      quantity: 1,
      grantedCredits: 10_000,
      amountTotal: 1250,
    });

    // Spend down to less than the full-refund target (10,000): the monthly
    // grant (3,000) goes first, then 9,000 of the 10,000 add-on grant,
    // leaving only 1,000 of add-on for the reversal to reclaim.
    await billing.meterConsume(
      teamId,
      {
        credits: runtimeConfig.defaultMonthlyCredits + 9_000,
        feature: "test",
        idempotencyKey: `spend_${id}`,
      },
      userId,
    );
    const before = await store.getAccount(teamId, userId);
    assert.equal(before?.monthlyCreditsBalance, 0);
    assert.equal(before?.addOnCreditsBalance, 1_000);

    const result = await billing.applyPaymentReversal({
      orderId,
      provider: "waffo",
      reversalId: "full_refund",
      kind: "refund",
      amount: { refundedTotal: 1250 },
      paidAmount: 1250,
      currency: "USD",
    });

    assert.equal(result.outcome, "applied");
    if (result.outcome === "applied") {
      assert.equal(result.deltaUnits, 10_000);
      assert.equal(result.recovered, 1_000);
      assert.equal(result.shortfall, 9_000);
      assert.equal(result.order.reversalStatus, "refunded");
      assert.equal(result.order.reversedUnits, 10_000);
    }

    // The transaction committed (no CHECK violation) and both balances
    // landed exactly at zero rather than going negative.
    const after = await store.getAccount(teamId, userId);
    assert.equal(after?.addOnCreditsBalance, 0);
    assert.equal(after?.monthlyCreditsBalance, 0);

    const row = await pool.query(
      "select add_on_credits_balance, monthly_credits_balance from billing_accounts where team_id=$1 and user_id=$2",
      [teamId, userId],
    );
    assert.equal(row.rows[0]?.add_on_credits_balance, 0);
    assert.equal(row.rows[0]?.monthly_credits_balance, 0);
  } finally {
    try {
      await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
      await pool.query("delete from billing_orders where id=$1", [orderId]);
      await pool.query("delete from billing_accounts where team_id=$1", [
        teamId,
      ]);
    } finally {
      await pool.end();
    }
  }
});

test("listStrandedWebhookEvents returns only failed rows of the provider received before the cutoff, oldest first, capped by limit", async () => {
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
  const now = new Date();
  const cutoff = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  const seededIds: string[] = [];

  async function seed(input: {
    provider: "creem" | "waffo";
    status: "failed" | "processed";
    hoursAgo: number;
  }) {
    const created = await store.insertWebhookEvent({
      provider: input.provider,
      providerEventId: `evt_${randomUUID()}`,
      eventType: "subscription.active",
      teamId: "team_stranded",
      externalSubscriptionId: "ext_sub_stranded",
      payload: {},
      metadata: {},
    });
    await store.updateWebhookEventState(created.id, {
      status: input.status,
      errorCode: input.status === "failed" ? "processing_error" : null,
    });
    await pool.query(
      "update billing_webhook_events set received_at=$1 where id=$2",
      [new Date(now.getTime() - input.hoursAgo * 60 * 60 * 1000), created.id],
    );
    seededIds.push(created.id);
    return created.id;
  }

  try {
    const oldest = await seed({
      provider: "creem",
      status: "failed",
      hoursAgo: 10,
    });
    const middle = await seed({
      provider: "creem",
      status: "failed",
      hoursAgo: 8,
    });
    await seed({ provider: "creem", status: "failed", hoursAgo: 1 }); // inside the redelivery window: not stranded yet
    await seed({ provider: "creem", status: "processed", hoursAgo: 9 }); // not failed
    await seed({ provider: "waffo", status: "failed", hoursAgo: 9 }); // different provider

    const limited = await store.listStrandedWebhookEvents({
      provider: "creem",
      receivedBefore: cutoff,
      limit: 1,
    });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.id, oldest);

    const all = await store.listStrandedWebhookEvents({
      provider: "creem",
      receivedBefore: cutoff,
      limit: 50,
    });
    assert.deepEqual(
      all.map((row) => row.id),
      [oldest, middle],
    );
    assert.ok(
      all.every((row) => row.status === "failed" && row.provider === "creem"),
    );
  } finally {
    try {
      await pool.query(
        "delete from billing_webhook_events where id = any($1)",
        [seededIds],
      );
    } finally {
      await pool.end();
    }
  }
});
