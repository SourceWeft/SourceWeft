import assert from "node:assert/strict";
import { test } from "vitest";
import { BillingAccountService } from "./account-service";
import { BillingUsageService } from "./usage-service";
import { runtimeConfig, MemoryBillingStore } from "./test-fixtures";

for (const [tokens, expected] of [
  [1, 1],
  [1000, 1],
  [1001, 2],
  [2501, 3],
] as const) {
  test(`existing unpaginated ingestion meters ${tokens} tokens as ${expected} pages`, async () => {
    const store = new MemoryBillingStore();
    const account = new BillingAccountService(store, runtimeConfig);
    const usage = new BillingUsageService(store, runtimeConfig, account);
    const input = {
      parsedTokens: tokens,
      feature: "ingestion",
      idempotencyKey: `text-${tokens}`,
    };
    const first = await usage.meterIngestion("team_1", input, "user_1");
    const replay = await usage.meterIngestion("team_1", input, "user_1");
    assert.equal(first.pagesConsumed, expected);
    assert.equal(replay.idempotencyReplayed, true);
    const entries = store.ledgers.filter(
      (entry) => entry.unitType === "page" && entry.eventType === "consume",
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.delta, -expected);
    assert.equal(replay.pagesRemaining, 300 - expected);
  });
}

test("existing reported-page ingestion keeps physical pages ahead of long text", async () => {
  const store = new MemoryBillingStore();
  const account = new BillingAccountService(store, runtimeConfig);
  const usage = new BillingUsageService(store, runtimeConfig, account);
  const result = await usage.meterIngestion(
    "team_1",
    {
      pages: 2,
      parsedTokens: 9000,
      feature: "ingestion",
      idempotencyKey: "physical-pdf",
    },
    "user_1",
  );
  assert.equal(result.pagesConsumed, 2);
  assert.equal(
    store.ledgers.find(
      (entry) => entry.eventType === "consume" && entry.unitType === "page",
    )?.delta,
    -2,
  );
});
