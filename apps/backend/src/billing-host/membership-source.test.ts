import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { test } from "vitest";
import { createBillingMembershipSource } from "./membership-source";
test("membership reads stay on the caller's transaction and bind the organization as a parameter", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query() {
      throw new Error(
        "Transaction must not escape to another pooled connection",
      );
    },
  } as unknown as Pool;
  const client = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return {
        rows: sql.includes('select "userId"')
          ? [{ userId: "member-1" }]
          : [{ count: "2" }],
      };
    },
  } as unknown as PoolClient;
  const source = createBillingMembershipSource(pool);
  assert.deepEqual(await source.listTeamMemberUserIds("org-1", client), [
    "member-1",
  ]);
  assert.equal(await source.countTeamMembers("org-1", client), 2);
  assert.equal(await source.countPendingTeamInvitations("org-1", client), 2);
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (call) => call.values[0] === "org-1" && call.sql.includes("$1"),
    ),
  );
  assert.match(calls[2]!.sql, /status = 'pending'/);
  assert.match(calls[2]!.sql, /"expiresAt" > now\(\)/);
});
