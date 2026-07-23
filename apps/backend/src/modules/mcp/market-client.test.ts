import assert from "node:assert/strict";
import { test } from "vitest";
import { MarketClient, MarketClientError } from "@sourceweft/market-sdk";

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("MarketClient returns a schema-valid list response unchanged", async () => {
  const client = new MarketClient({
    baseUrl: "http://localhost:3011",
    fetch: stubFetch({ items: [], nextCursor: null }),
  });

  const result = await client.listMcp({});
  assert.deepEqual(result, { items: [], nextCursor: null });
});

test("MarketClient rejects a response that violates the contract", async () => {
  const client = new MarketClient({
    baseUrl: "http://localhost:3011",
    // items must be an array; a string is contract drift the client must catch.
    fetch: stubFetch({ items: "nope", nextCursor: null }),
  });

  await assert.rejects(
    () => client.listMcp({}),
    (error) =>
      error instanceof MarketClientError &&
      error.code === "MARKET_RESPONSE_INVALID",
  );
});
