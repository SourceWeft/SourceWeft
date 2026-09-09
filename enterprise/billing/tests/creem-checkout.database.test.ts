import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "vitest";
import { Pool } from "pg";
import { BillingService } from "../src/server/service";
import { PostgresBillingStore } from "../src/server/store";
import { createCreemSubscriptionSync } from "../src/server/providers/creem-subscription-sync";
import { createCreemWebhookHandler } from "../src/server/providers/creem-webhook-bypass";
import { runtimeConfig, noopProvider } from "./test-fixtures";

test("concurrent signed Creem callbacks produce one persisted top-up grant", async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url && /^\/sourceweft_billing_test/.test(new URL(url).pathname));
  const pool = new Pool({ connectionString: url, max: 12 });
  const id = randomUUID(),
    teamId = `creem_team_${id}`,
    userId = `creem_user_${id}`,
    eventId = `evt_creem_${id}`;
  const config = {
    ...runtimeConfig,
    saasEnabled: true,
    provider: "creem" as const,
    creem: { ...runtimeConfig.creem, webhookSecret: "creem-db-test-signature" },
  };
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
  const billing = new BillingService(store, config, {
    ...noopProvider,
    async checkoutMetadata() {
      return { paymentEnvironment: "test" };
    },
    async createCheckout() {
      return {
        provider: "creem",
        checkoutUrl: "https://test-checkout.creem.io/test",
        externalCheckoutId: `ch_${id}`,
        externalCustomerId: null,
      };
    },
  });
  const sync = createCreemSubscriptionSync({
    billing,
    config,
    logger: { info() {}, warn() {}, error() {} },
    alerts: { async trigger() {}, async resolve() {} },
  });
  const handler = createCreemWebhookHandler({
    config,
    sync,
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    await billing.ensureBillingAccount(teamId, userId);
    const checkout = await billing.createTopupCheckout(
      teamId,
      { unitType: "page", quantity: 1 },
      userId,
      "buyer@example.invalid",
    );
    const order = (await store.getOrderById(checkout.orderId))!;
    const object = {
      id: `ch_${id}`,
      mode: "test",
      status: "completed",
      units: 1,
      request_id: `order:${order.id}`,
      metadata: { orderId: order.id, userId, teamId, kind: "page_topup" },
      product: { id: order.externalProductId },
      customer: { id: `cust_${id}` },
      order: {
        id: `ord_${id}`,
        mode: "test",
        type: "onetime",
        status: "paid",
        amount: 500,
        currency: "USD",
        product: order.externalProductId,
      },
    };
    const raw = JSON.stringify({
      id: eventId,
      eventType: "checkout.completed",
      created_at: Date.now(),
      object,
    });
    const signature = createHmac("sha256", config.creem.webhookSecret)
      .update(raw)
      .digest("hex");
    const deliver = () =>
      handler(
        new Request("http://localhost/api/auth/creem/webhook", {
          method: "POST",
          headers: { "creem-signature": signature },
          body: raw,
        }),
      );
    const results = await Promise.all(Array.from({ length: 6 }, deliver));
    for (const result of results) assert.equal(result?.status, 200);
    assert.equal((await store.getOrderById(order.id))?.status, "fulfilled");
    assert.equal(
      (await store.getAccount(teamId, userId))?.addOnPagesBalance,
      1000,
    );
    const grants = await pool.query(
      "select count(*)::int as n from usage_ledgers where team_id=$1 and reference_id=$2 and event_type='grant'",
      [teamId, order.id],
    );
    assert.equal(grants.rows[0].n, 1);
    assert.equal(
      (await store.getWebhookEventByProviderEventId("creem", eventId))?.status,
      "processed",
    );
  } finally {
    await pool.query(
      "delete from billing_webhook_events where provider='creem' and provider_event_id=$1",
      [eventId],
    );
    await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
    await pool.query("delete from billing_orders where user_id=$1", [userId]);
    await pool.query("delete from billing_accounts where team_id=$1", [teamId]);
    await pool.end();
  }
});
