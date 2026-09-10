import assert from "node:assert/strict";
import { test } from "vitest";
import { WaffoPancake } from "@waffo/pancake-ts";
import { setupWaffoCatalog } from "../src/server/providers/waffo/setup";
import {
  createWaffoFixture,
  merchantId,
  signingKey,
  storeId,
  waffoConfig,
} from "./waffo-fixtures";

function setupClient(
  stores: Array<{ id: string; name: string; status: string }>,
  subscriptionProducts: Array<{
    id: string;
    metadata: string;
    status: string;
    billingPeriod: string;
  }> = [],
) {
  const requests: Array<{ path: string; body: any }> = [];
  const client = new WaffoPancake({
    merchantId,
    privateKey: signingKey.privateKey,
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      requests.push({ path, body });
      let data;
      if (path === "/v1/graphql")
        data = body.query.includes("stores {")
          ? { stores }
          : { onetimeProducts: [], subscriptionProducts };
      else if (path.includes("create-store")) data = { store: { id: storeId } };
      else
        data = {
          product: { id: `PROD_${String(requests.length).padStart(22, "0")}` },
        };
      return new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requests };
}

test("multiple merchant stores require explicit selection before product creation", async () => {
  const f = createWaffoFixture();
  f.state.settings = null;
  const { client, requests } = setupClient([
    { id: storeId, name: "One", status: "active" },
    { id: "STO_other", name: "Two", status: "active" },
  ]);
  await assert.rejects(
    setupWaffoCatalog({ client, config: waffoConfig, state: f.state }),
    (error: any) => error.code === "WAFFO_STORE_SELECTION_REQUIRED",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "/v1/graphql");
});

test("empty merchant creates a test store and persists product IDs without extra env vars or publishing", async () => {
  const f = createWaffoFixture();
  f.state.settings = null;
  const { client, requests } = setupClient([]);
  const result = await setupWaffoCatalog({
    client,
    config: waffoConfig,
    state: f.state,
  });
  assert.equal(result.storeId, storeId);
  assert.equal(Object.keys(result.products).length, 4);
  assert.deepEqual(result, f.state.settings);
  const products = requests.filter((r) => r.path.includes("create-product"));
  assert.equal(products.length, 4);
  assert.ok(
    products.every((r) => typeof r.body.prices.USD.amount === "string"),
  );
  assert.equal(
    requests.some((r) => r.path.includes("publish")),
    false,
  );
});

test("single store is reused and setup cannot publish or bootstrap production", async () => {
  const f = createWaffoFixture();
  f.state.settings = null;
  const { client, requests } = setupClient([
    { id: storeId, name: "One", status: "active" },
  ]);
  await setupWaffoCatalog({ client, config: waffoConfig, state: f.state });
  assert.equal(
    requests.some((r) => r.path.includes("create-store")),
    false,
  );
  await assert.rejects(
    setupWaffoCatalog({
      client,
      config: {
        ...waffoConfig,
        waffo: { ...waffoConfig.waffo, environment: "prod" },
      },
      state: f.state,
    }),
    /TEST API Key/,
  );
});

test("an existing product with a wrong recurring period is rejected before creating more products", async () => {
  const f = createWaffoFixture();
  f.state.settings = null;
  const { client, requests } = setupClient(
    [{ id: storeId, name: "One", status: "active" }],
    [
      {
        id: "PROD_2aUyqjCzEIiEcYMKj7TZtw",
        metadata: JSON.stringify({
          sourceweftProductKey: "individual_pro:monthly",
        }),
        status: "active",
        billingPeriod: "yearly",
      },
    ],
  );
  await assert.rejects(
    setupWaffoCatalog({ client, config: waffoConfig, state: f.state }),
    (error: any) => error.code === "WAFFO_PRODUCT_PERIOD_MISMATCH",
  );
  assert.ok(requests.every((request) => request.path === "/v1/graphql"));
});
