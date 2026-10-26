import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  defaultBillingCatalog,
  parseBillingCatalog,
  toDisplayCatalog,
} from "../src/catalog/billing-catalog";
import { readBillingCatalogFile } from "../src/server/catalog-file";

function clone(): Record<string, any> {
  return structuredClone(defaultBillingCatalog) as Record<string, any>;
}

test("the shipped catalog carries today's plan prices, quotas and top-up packs", () => {
  assert.deepEqual(defaultBillingCatalog.credits, {
    unitUsd: 0.00125,
    markupRate: 0.25,
  });
  assert.deepEqual(defaultBillingCatalog.plans.free, {
    credits: 3000,
    pages: 300,
  });
  assert.equal(defaultBillingCatalog.plans.pro.credits, 8000);
  assert.equal(defaultBillingCatalog.plans.pro.pages, 6000);
  assert.deepEqual(defaultBillingCatalog.plans.pro.priceCents, {
    monthly: 990,
    yearly: 9900,
  });
  assert.equal(defaultBillingCatalog.plans.team.credits, 8000);
  assert.equal(defaultBillingCatalog.plans.team.pages, 6000);
  assert.equal(defaultBillingCatalog.plans.team.minSeats, 2);
  assert.deepEqual(defaultBillingCatalog.plans.team.priceCents, {
    monthly: 990,
    yearly: 9900,
  });
  assert.deepEqual(defaultBillingCatalog.topups, {
    credit: { units: 10000, priceCents: 1250 },
    page: { units: 1000, priceCents: 500 },
  });
});

test.each([
  ["a typo'd key", (c: any) => (c.plans.pro.priceCent = 1), "priceCent"],
  [
    "fractional cents",
    (c: any) => (c.plans.pro.priceCents.monthly = 9.9),
    "plans.pro.priceCents.monthly",
  ],
  [
    "negative credits",
    (c: any) => (c.plans.free.credits = -1),
    "plans.free.credits",
  ],
  [
    "zero minimum seats",
    (c: any) => (c.plans.team.minSeats = 0),
    "plans.team.minSeats",
  ],
  [
    "a zero credit unit",
    (c: any) => (c.credits.unitUsd = 0),
    "credits.unitUsd",
  ],
  ["another currency", (c: any) => (c.currency = "eur"), "currency"],
])("parseBillingCatalog rejects %s", (_label, mutate, expected) => {
  const catalog = clone();
  mutate(catalog);
  assert.throws(
    () => parseBillingCatalog(catalog),
    (error: unknown) => {
      assert.match((error as Error).message, /^Invalid billing catalog:/);
      assert.ok((error as Error).message.includes(expected));
      return true;
    },
  );
});

test("the display catalog has prices and quotas but no product IDs or credit unit", () => {
  const catalog = clone();
  catalog.plans.pro.creemProductId = {
    monthly: "prod_pro_m",
    yearly: "prod_pro_y",
  };
  catalog.topups.credit.creemProductId = "prod_credit";
  const display = toDisplayCatalog(parseBillingCatalog(catalog));
  const text = JSON.stringify(display);
  assert.ok(!text.includes("prod_"));
  assert.ok(!text.includes("creemProductId"));
  assert.ok(!text.includes("unitUsd"));
  assert.ok(!text.includes("markupRate"));
  assert.deepEqual(display.plans.pro.priceCents, {
    monthly: 990,
    yearly: 9900,
  });
  assert.equal(display.plans.team.minSeats, 2);
  assert.deepEqual(display.topups.page, { units: 1000, priceCents: 500 });
});

test("readBillingCatalogFile fingerprints the file text and names the path on failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "billing-catalog-"));
  try {
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    const changed = clone();
    changed.credits.unitUsd = 0.002;
    writeFileSync(first, JSON.stringify(defaultBillingCatalog));
    writeFileSync(second, JSON.stringify(changed));

    const a = readBillingCatalogFile(first);
    const b = readBillingCatalogFile(second);
    assert.equal(a.fingerprint.length, 12);
    assert.match(a.fingerprint, /^[0-9a-f]{12}$/);
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.equal(a.filePath, first);
    assert.equal(b.catalog.credits.unitUsd, 0.002);

    assert.throws(
      () => readBillingCatalogFile(join(dir, "missing.json")),
      /missing\.json/,
    );
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    assert.throws(() => readBillingCatalogFile(bad), /bad\.json/);
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ ...changed, version: 2 }));
    assert.throws(() => readBillingCatalogFile(invalid), /invalid\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
