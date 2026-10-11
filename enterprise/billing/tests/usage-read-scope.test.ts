import assert from "node:assert/strict";
import { test } from "vitest";
import { BillingAccountService } from "../src/server/account-service";
import { BillingUsageService } from "../src/server/usage-service";
import type { BillingLedgerRow } from "../src/server/types";
import { MemoryBillingStore, runtimeConfig } from "./test-fixtures";

function ledger(
  id: string,
  overrides: Partial<BillingLedgerRow> = {},
): BillingLedgerRow {
  return {
    id,
    teamId: "team",
    workspaceId: null,
    actorUserId: "self",
    feature: "chat",
    eventType: "consume",
    unitType: "credit",
    delta: -5,
    balanceAfter: 100,
    referenceId: null,
    idempotencyKey: null,
    operationId: null,
    operationType: "usage",
    activityVisible: true,
    activityTitle: null,
    activitySummary: null,
    metadata: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test.each([1, 2, 3, 7])(
  "ledger pages of %i return every entry exactly once, including tied timestamps",
  async (limit) => {
    const store = new MemoryBillingStore();
    const service = new BillingUsageService(
      store,
      runtimeConfig,
      new BillingAccountService(store, runtimeConfig),
    );
    const expected = ["07", "06", "05", "04", "03", "02", "01"];
    store.ledgers = expected.map((id, index) =>
      ledger(id, {
        createdAt: new Date(
          Date.UTC(2026, 0, 5 - Math.floor(index / 3)),
        ).toISOString(),
      }),
    );
    const ids: string[] = [];
    let cursor: { createdAt: Date; id: string } | null = null;
    for (let pageNumber = 0; pageNumber <= expected.length; pageNumber++) {
      const page = await service.getLedger("team", limit, { cursor });
      ids.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      const decoded = JSON.parse(
        Buffer.from(page.nextCursor, "base64url").toString("utf8"),
      );
      cursor = { createdAt: new Date(decoded.createdAt), id: decoded.id };
    }
    assert.deepEqual(ids, expected);
    assert.equal(new Set(ids).size, expected.length);
  },
);

test("member usage includes their credits, refunds and pages but excludes peers and other teams", async () => {
  const store = new MemoryBillingStore();
  const service = new BillingUsageService(
    store,
    runtimeConfig,
    new BillingAccountService(store, runtimeConfig),
  );
  const account = await service.ensureBillingAccount("team", "self");
  const createdAt = new Date(
    Date.parse(account.cycleStartAt) + 1000,
  ).toISOString();
  store.ledgers = [
    ledger("own-charge", { createdAt, delta: -10 }),
    ledger("own-refund", { createdAt, eventType: "refund", delta: 2 }),
    ledger("own-pages", {
      createdAt,
      feature: "ingestion",
      unitType: "page",
      delta: -3,
    }),
    ledger("peer-charge", { createdAt, actorUserId: "peer", delta: -100 }),
    ledger("peer-pages", {
      createdAt,
      actorUserId: "peer",
      feature: "peer-only",
      unitType: "page",
      delta: -99,
    }),
    ledger("foreign-charge", { createdAt, teamId: "other-team", delta: -200 }),
  ];
  const usage = await service.getUsage("team", "self");
  assert.deepEqual(usage.totals, {
    creditsConsumed: 8,
    pagesConsumed: 3,
    events: 3,
  });
  assert.deepEqual(usage.items, [
    { feature: "chat", creditsConsumed: 8, pagesConsumed: 0, events: 2 },
    { feature: "ingestion", creditsConsumed: 0, pagesConsumed: 3, events: 1 },
  ]);
});
