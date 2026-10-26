// The billing catalog says what each Creem product should cost, but Creem
// charges its own product price. `monitorCreemCatalogPrices` compares the two
// and raises an ops alert on drift; it never blocks checkout.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  listCatalogCreemProducts,
  monitorCreemCatalogPrices,
} from "../src/server/providers/creem-catalog-monitor";
import type { BillingAlertSink, BillingLogger } from "../src/server/host";
import { runtimeConfig } from "./test-fixtures";

type Alert = Parameters<BillingAlertSink["trigger"]>[0];

function recorders() {
  const triggered: Alert[] = [];
  const resolved: string[] = [];
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const alerts: BillingAlertSink = {
    async trigger(input) {
      triggered.push(input);
    },
    async resolve(key) {
      resolved.push(key);
    },
  };
  const logger: BillingLogger = {
    info() {},
    warn() {},
    error(message, fields) {
      errors.push({ message, fields });
    },
  };
  return { triggered, resolved, errors, alerts, logger };
}

const products = [
  { productId: "prod_pro_m", label: "Pro monthly", expectedPriceCents: 990 },
  { productId: "prod_pro_y", label: "Pro yearly", expectedPriceCents: 9900 },
];

test("a product that matches the catalog resolves its alert and raises nothing", async () => {
  const r = recorders();
  const result = await monitorCreemCatalogPrices({
    products,
    getProduct: async (id) => ({
      price: id === "prod_pro_m" ? 990 : 9900,
      currency: "USD",
    }),
    alerts: r.alerts,
    logger: r.logger,
  });
  assert.deepEqual(result, { checked: 2, mismatched: 0 });
  assert.equal(r.triggered.length, 0);
  assert.deepEqual(r.resolved, [
    "billing:creem-catalog-price-mismatch:prod_pro_m",
    "billing:creem-catalog-price-mismatch:prod_pro_y",
  ]);
});

test("a price that differs from the catalog raises one error alert with both amounts", async () => {
  const r = recorders();
  const result = await monitorCreemCatalogPrices({
    products,
    getProduct: async (id) => ({
      price: id === "prod_pro_m" ? 2000 : 9900,
      currency: "usd",
    }),
    alerts: r.alerts,
    logger: r.logger,
  });
  assert.deepEqual(result, { checked: 2, mismatched: 1 });
  assert.equal(r.triggered.length, 1);
  const alert = r.triggered[0]!;
  assert.equal(
    alert.alertKey,
    "billing:creem-catalog-price-mismatch:prod_pro_m",
  );
  assert.equal(alert.level, "error");
  assert.equal(alert.source, "billing.creem");
  assert.equal(alert.metadata?.expectedPriceCents, 990);
  assert.equal(alert.metadata?.actualPriceCents, 2000);
  assert.equal(alert.metadata?.productId, "prod_pro_m");
  assert.deepEqual(r.resolved, [
    "billing:creem-catalog-price-mismatch:prod_pro_y",
  ]);
});

test("a product priced in another currency is a mismatch", async () => {
  const r = recorders();
  const result = await monitorCreemCatalogPrices({
    products: [products[0]!],
    getProduct: async () => ({ price: 990, currency: "EUR" }),
    alerts: r.alerts,
    logger: r.logger,
  });
  assert.deepEqual(result, { checked: 1, mismatched: 1 });
  assert.equal(r.triggered[0]?.metadata?.actualCurrency, "EUR");
});

test("a Creem failure on one product is logged and the others are still checked", async () => {
  const r = recorders();
  const result = await monitorCreemCatalogPrices({
    products,
    getProduct: async (id) => {
      if (id === "prod_pro_m") throw new Error("Creem unavailable");
      return { price: 9900, currency: "usd" };
    },
    alerts: r.alerts,
    logger: r.logger,
  });
  assert.deepEqual(result, { checked: 1, mismatched: 0 });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]?.fields?.productId, "prod_pro_m");
  assert.equal(r.triggered.length, 0);
});

test("an alert-sink failure does not stop the remaining products", async () => {
  const r = recorders();
  const failing: BillingAlertSink = {
    async trigger() {
      throw new Error("ops sink down");
    },
    async resolve() {
      throw new Error("ops sink down");
    },
  };
  const result = await monitorCreemCatalogPrices({
    products,
    getProduct: async () => ({ price: 1, currency: "usd" }),
    alerts: failing,
    logger: r.logger,
  });
  assert.deepEqual(result, { checked: 2, mismatched: 2 });
  assert.equal(r.errors.length, 2);
});

test("listCatalogCreemProducts lists every configured product with its catalog price and skips empty IDs", () => {
  const list = listCatalogCreemProducts({
    ...runtimeConfig,
    creem: {
      ...runtimeConfig.creem,
      individualProMonthlyProductId: "prod_pm",
      individualProYearlyProductId: "prod_py",
      teamStandardMonthlyProductId: "",
      teamStandardYearlyProductId: "prod_ty",
      creditTopupProductId: "prod_credit",
      pageTopupProductId: "",
    },
    catalog: {
      ...runtimeConfig.catalog,
      individualProMonthlyAmountCents: 990,
      individualProYearlyAmountCents: 9900,
      teamStandardYearlyAmountCents: 9900,
      creditTopupAmountCents: 1250,
    },
  });
  assert.deepEqual(
    list.map((p) => [p.productId, p.expectedPriceCents]),
    [
      ["prod_pm", 990],
      ["prod_py", 9900],
      ["prod_ty", 9900],
      ["prod_credit", 1250],
    ],
  );
});
