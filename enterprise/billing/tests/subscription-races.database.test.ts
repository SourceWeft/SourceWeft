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

test.each([1, 2, 3])(
  "shared PostgreSQL lifecycle serializes purchases and protects a replacement from old Stripe events (run %i)",
  async () => {
    const url = process.env.DATABASE_URL;
    assert.ok(url && /^\/sourceweft_billing_test/.test(new URL(url).pathname));
    const pool = new Pool({ connectionString: url, max: 16 });
    const suffix = randomUUID();
    const teamId = `repair_${suffix}`;
    const userId = `repair_user_${suffix}`;
    const f = stripeFixture({ sessionPrefix: suffix });
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
    const inbox = new StripeWebhookService({
      config: stripeConfig,
      provider,
      store,
      state: new PostgresStripeInboxStore(pool),
      billing,
      logger: { info() {}, warn() {}, error() {} },
    });
    const create = () =>
      billing.createPricingCheckout(
        { plan: "pro", billingInterval: "monthly", source: "dashboard" },
        { userId, email: "test@example.invalid" },
        { personalTeamId: teamId },
      );
    async function deliver(type: string, object: unknown) {
      const event = f.event(
        type,
        object,
        `evt_repair_${suffix}_${randomUUID()}`,
      );
      const signed = f.sign(event);
      await inbox.receive(signed.raw, signed.signature);
      await inbox.drain();
    }
    try {
      assert.equal(
        (
          await pool.query(
            "select to_regclass('public.creem_subscription') as legacy",
          )
        ).rows[0].legacy,
        null,
      );
      await billing.ensureBillingAccount(teamId, userId);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, create),
      );
      const first = results.find((row) => row.status === "fulfilled");
      assert.ok(
        first?.status === "fulfilled",
        JSON.stringify(
          results.map((row) =>
            row.status === "rejected" ? row.reason.message : "ok",
          ),
        ),
      );
      for (const row of results)
        if (row.status === "rejected")
          assert.equal(row.reason.code, "SUBSCRIPTION_PAYMENT_PENDING");
      assert.equal(
        f.requests.filter(
          (r) => r.method === "POST" && r.path === "/v1/checkout/sessions",
        ).length,
        1,
      );
      const order = await store.getOrderById(first.value.orderId);
      const session = f.pay(order!.externalCheckoutId!);
      session.subscription = `sub_old_${suffix}`;
      f.remote.subscription!.id = session.subscription;
      await deliver("checkout.session.completed", session);
      const oldBinding = (await store.getSubscriptionByTeam(teamId))!
        .currentBindingId;
      assert.ok(oldBinding);
      await assert.rejects(
        create,
        (error: any) => error.code === "SUBSCRIPTION_ALREADY_ACTIVE",
      );
      f.remote.subscription!.status = "canceled";
      await deliver("customer.subscription.deleted", f.remote.subscription);
      const oldRemote = structuredClone(f.remote.subscription!);
      const replacement = await create();
      const newOrder = await store.getOrderById(replacement.orderId);
      const newSession = f.pay(newOrder!.externalCheckoutId!);
      newSession.subscription = `sub_new_${suffix}`;
      f.remote.subscription!.id = newSession.subscription;
      await deliver("checkout.session.completed", newSession);
      const current = (await store.getSubscriptionByTeam(teamId))!;
      const fulfilledNew = await store.getOrderById(replacement.orderId);
      assert.equal(
        fulfilledNew?.status,
        "fulfilled",
        fulfilledNew?.errorMessage ??
          JSON.stringify(
            (
              await pool.query(
                "select status,error_code,error_message from billing_webhook_events where provider_event_id like $1",
                [`%evt_repair_${suffix}%`],
              )
            ).rows,
          ),
      );
      assert.notEqual(current.currentBindingId, oldBinding);
      assert.equal(current.status, "active");
      f.remote.subscription = oldRemote;
      await deliver("customer.subscription.updated", oldRemote);
      assert.equal(
        (await store.getSubscriptionByTeam(teamId))!.currentBindingId,
        current.currentBindingId,
      );
      assert.equal(
        (await store.getSubscriptionByTeam(teamId))!.status,
        "active",
      );
      assert.equal(
        (
          await pool.query(
            "select count(*)::int as n from billing_subscription_bindings where team_id=$1",
            [teamId],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await pool.query(
            "select count(*)::int as n from billing_subscription_operations where target_key=$1 and status<>'succeeded'",
            [`team:${teamId}`],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await pool.query(
        "delete from billing_webhook_events where provider_event_id like $1",
        [`%evt_repair_${suffix}%`],
      );
      await pool.query(
        "delete from billing_subscription_operations where target_key=$1",
        [`team:${teamId}`],
      );
      await pool.query(
        "delete from billing_subscription_bindings where team_id=$1",
        [teamId],
      );
      await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
      await pool.query("delete from subscriptions where team_id=$1", [teamId]);
      await pool.query("delete from billing_orders where user_id=$1", [userId]);
      await pool.query("delete from billing_accounts where team_id=$1", [
        teamId,
      ]);
      await pool.end();
    }
  },
);
