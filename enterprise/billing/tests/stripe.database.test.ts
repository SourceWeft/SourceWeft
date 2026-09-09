import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test } from "vitest";
import { PostgresBillingStore } from "../src/server/store";
import { BillingService } from "../src/server/service";
import { StripeBillingProvider } from "../src/server/providers/stripe/provider";
import { StripeWebhookService } from "../src/server/providers/stripe/webhook";
import { PostgresStripeInboxStore } from "../src/server/providers/stripe/state";
import { stripeFixture, stripeConfig } from "./stripe-fixtures";

test("Postgres Stripe inbox persists verified events and concurrent processors fulfill once", async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(
    url && /^\/sourceweft_billing_test/.test(new URL(url).pathname),
    "Use an isolated billing test database",
  );
  const pool = new Pool({ connectionString: url, max: 8 });
  const id = randomUUID();
  const teamId = `stripe_db_${id}`;
  const userId = `stripe_user_${id}`;
  const f = stripeFixture({ sessionPrefix: id });
  const store = new PostgresBillingStore(pool, {
    async listTeamMemberUserIds() {
      return [userId];
    },
    async countTeamMembers() {
      return 1;
    },
    async countPendingTeamInvitations() {
      return 0;
    },
  });
  const provider = new StripeBillingProvider(stripeConfig, f.client);
  const billing = new BillingService(store, stripeConfig, provider);
  const state = new PostgresStripeInboxStore(pool);
  const inbox = () =>
    new StripeWebhookService({
      config: stripeConfig,
      provider,
      state,
      store,
      billing,
      logger: { info() {}, warn() {}, error() {} },
    });
  let orderId: string | undefined;
  try {
    await billing.ensureBillingAccount(teamId, userId);
    const order = await billing.createTopupCheckout(
      teamId,
      { unitType: "credit", quantity: 1, clientReferenceKey: id },
      userId,
      "buyer@example.invalid",
    );
    orderId = order.orderId;
    const dbOrder = await store.getOrderById(orderId);
    assert.ok(dbOrder?.externalCheckoutId);
    const event = f.event(
      "checkout.session.completed",
      f.pay(dbOrder.externalCheckoutId),
      `evt_${id}`,
    );
    const signed = f.sign(event);
    await Promise.all([
      inbox().receive(signed.raw, signed.signature),
      inbox().receive(signed.raw, signed.signature),
    ]);
    assert.equal((await store.getOrderById(orderId))?.paymentStatus, "unpaid");
    await Promise.all([inbox().drain(), inbox().drain()]);
    assert.equal((await store.getOrderById(orderId))?.status, "fulfilled");
    assert.equal(
      (await store.getAccount(teamId, userId))?.addOnCreditsBalance,
      stripeConfig.catalog.creditTopupUnitAmount,
    );
    await inbox().receive(signed.raw, signed.signature);
    await inbox().drain();
    const count = await pool.query(
      "select count(*)::int as n from usage_ledgers where team_id=$1 and reference_id=$2 and operation_type='topup'",
      [teamId, orderId],
    );
    assert.equal(count.rows[0].n, 1);
    const receipts = await pool.query(
      "select status from billing_webhook_events where provider='stripe' and provider_event_id=$1",
      [`test:evt_${id}`],
    );
    assert.equal(receipts.rows.length, 1);
    assert.equal(receipts.rows[0].status, "processed");
  } finally {
    await pool.query(
      "delete from billing_webhook_events where provider='stripe' and provider_event_id=$1",
      [`test:evt_${id}`],
    );
    await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
    if (orderId)
      await pool.query("delete from billing_orders where id=$1", [orderId]);
    await pool.query("delete from billing_accounts where team_id=$1", [teamId]);
    await pool.end();
  }
}, 30_000);
