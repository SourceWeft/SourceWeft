import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test } from "vitest";
import {
  WaffoPancake,
  verifyWebhook,
  type WebhookEvent,
} from "@waffo/pancake-ts";
import { PostgresBillingStore } from "../src/server/store";
import { BillingService } from "../src/server/service";
import { WaffoBillingProvider } from "../src/server/providers/waffo/provider";
import { PostgresWaffoStateStore } from "../src/server/providers/waffo/state";
import { WaffoWebhookService } from "../src/server/providers/waffo/webhook";
import {
  signingKey,
  signedEvent,
  productId,
  waffoConfig,
} from "./waffo-fixtures";

test("Postgres Waffo inbox survives restart and concurrent duplicate deliveries grant once", async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(
    url && /^\/sourceweft_billing_test/.test(new URL(url).pathname),
    "Use the isolated billing test database",
  );
  const pool = new Pool({ connectionString: url, max: 8 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 22);
  const merchantId = `MER_${suffix}`;
  const storeId = `STO_${suffix}`;
  const teamId = `waffo_db_${suffix}`;
  const userId = `user_${suffix}`;
  const config = {
    ...waffoConfig,
    waffo: { ...waffoConfig.waffo, merchantId },
  };
  const state = new PostgresWaffoStateStore(pool);
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
  const client = new WaffoPancake({
    merchantId,
    privateKey: signingKey.privateKey,
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: {
            checkoutUrl: `https://pancake.waffo.ai/checkout/cs_${suffix}`,
            sessionId: `cs_${suffix}`,
            expiresAt: new Date(Date.now() + 2_700_000).toISOString(),
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const billing = new BillingService(
    store,
    config,
    new WaffoBillingProvider(config, state, client),
  );
  const makeInbox = () =>
    new WaffoWebhookService({
      config,
      state,
      store,
      billing,
      logger: { info() {}, warn() {}, error() {} },
      verify: (raw, signature, environment) =>
        verifyWebhook(raw, signature, {
          environment,
          publicKey: signingKey.publicKey,
        }),
    });
  let orderId: string | undefined;
  try {
    await state.saveSettings({
      merchantId,
      environment: "test",
      storeId,
      products: { credit_topup: productId },
    });
    assert.equal(
      (await state.getSettings(merchantId, "test"))?.storeId,
      storeId,
    );
    assert.equal(await state.getSettings(merchantId, "prod"), null);
    await billing.ensureBillingAccount(teamId, userId);
    const checkout = await billing.createTopupCheckout(
      teamId,
      { unitType: "credit", quantity: 1, clientReferenceKey: `db-${suffix}` },
      userId,
      "buyer@example.invalid",
    );
    orderId = checkout.orderId;
    const event: WebhookEvent = {
      id: `delivery_${suffix}`,
      eventId: `PAY_${suffix}`,
      eventType: "order.completed",
      timestamp: new Date().toISOString(),
      mode: "test",
      storeId,
      storeName: "Fixture store",
      data: {
        orderId: `ORD_${suffix}`,
        orderMerchantExternalId: orderId,
        orderMetadata: { sourceweftOrderId: orderId },
        productMetadata: { sourceweftProductKey: "credit_topup" },
        buyerEmail: "buyer@example.invalid",
        currency: "USD",
        amount: "12.50",
        total: "12.50",
        taxAmount: "0.00",
        productName: "SourceWeft Credits",
        paymentId: `PAY_${suffix}`,
        paymentStatus: "succeeded",
        orderStatus: "completed",
      },
    };
    const signed = signedEvent(event);
    await Promise.all([
      makeInbox().receive(signed.raw, signed.signature),
      makeInbox().receive(signed.raw, signed.signature),
    ]);
    assert.equal((await store.getOrderById(orderId))?.paymentStatus, "unpaid");
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from billing_webhook_events where metadata->>'waffoMerchantId'=$1",
          [merchantId],
        )
      ).rows[0].n,
      1,
    );
    // New processor instances use only the durable database receipts.
    await Promise.all([makeInbox().drain(), makeInbox().drain()]);
    assert.equal((await store.getOrderById(orderId))?.status, "fulfilled");
    assert.equal(
      (await store.getAccount(teamId, userId))?.addOnCreditsBalance,
      config.catalog.creditTopupUnitAmount,
    );
    await makeInbox().receive(signed.raw, signed.signature);
    await makeInbox().drain();
    const grants = await pool.query(
      "select count(*)::int as n from usage_ledgers where team_id=$1 and reference_id=$2 and operation_type='topup'",
      [teamId, orderId],
    );
    assert.equal(grants.rows[0].n, 1);
  } finally {
    await pool.query(
      "delete from billing_webhook_events where metadata->>'waffoMerchantId'=$1",
      [merchantId],
    );
    await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
    if (orderId)
      await pool.query("delete from billing_orders where id=$1", [orderId]);
    await pool.query("delete from billing_accounts where team_id=$1", [teamId]);
    await pool.query(
      "delete from billing_provider_settings where merchant_id=$1",
      [merchantId],
    );
    await pool.end();
  }
}, 30_000);
