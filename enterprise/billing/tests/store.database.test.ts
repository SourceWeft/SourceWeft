import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { test } from "vitest";
import { PostgresBillingStore } from "../src/server/store";
import { BillingService } from "../src/server/service";
import type { BillingLedgerRow } from "../src/server/types";
import { runtimeConfig, noopProvider } from "./test-fixtures";

test("Postgres billing preserves concurrent idempotency, member isolation and ledger transaction rollback", async () => {
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
  const store = new PostgresBillingStore(pool);
  const service = new BillingService(store, runtimeConfig, noopProvider);
  const teamId = `billing_test_${randomUUID()}`;
  const actor = `actor_${randomUUID()}`;
  const peer = `peer_${randomUUID()}`;
  try {
    await service.ensureBillingAccount(teamId, actor);
    await service.ensureBillingAccount(teamId, peer);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        service.meterConsume(
          teamId,
          {
            credits: 10,
            feature: "test",
            idempotencyKey: "concurrent-same-charge",
          },
          actor,
        ),
      ),
    );
    assert.equal(
      (await store.getAccount(teamId, actor))?.monthlyCreditsBalance,
      runtimeConfig.defaultMonthlyCredits - 10,
    );
    assert.equal(
      (await store.getAccount(teamId, peer))?.monthlyCreditsBalance,
      runtimeConfig.defaultMonthlyCredits,
    );
    const charges = await pool.query(
      "select count(*)::int as count from usage_ledgers where team_id=$1 and event_type='consume'",
      [teamId],
    );
    assert.equal(charges.rows[0].count, 1);

    class FailingLedgerStore extends PostgresBillingStore {
      override async appendLedger(row: BillingLedgerRow, client: PoolClient) {
        await super.appendLedger(row, client);
        throw new Error("injected failure after ledger insert");
      }
    }
    const failing = new BillingService(
      new FailingLedgerStore(pool),
      runtimeConfig,
      noopProvider,
    );
    await assert.rejects(
      failing.meterConsume(
        teamId,
        {
          credits: 7,
          feature: "test",
          idempotencyKey: "must-rollback",
        },
        actor,
      ),
      /injected failure/,
    );
    assert.equal(
      (await store.getAccount(teamId, actor))?.monthlyCreditsBalance,
      runtimeConfig.defaultMonthlyCredits - 10,
    );
    const afterFailure = await pool.query(
      "select count(*)::int as count from usage_ledgers where team_id=$1 and event_type='consume'",
      [teamId],
    );
    assert.equal(afterFailure.rows[0].count, 1);
  } finally {
    try {
      await pool.query("delete from usage_ledgers where team_id=$1", [teamId]);
      await pool.query("delete from billing_accounts where team_id=$1", [
        teamId,
      ]);
    } finally {
      await pool.end();
    }
  }
});
