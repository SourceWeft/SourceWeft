import assert from "node:assert/strict";
import { test } from "vitest";
import { formatPrice } from "../src/ui/format-price";

test("whole-dollar prices keep no decimals", () => {
  assert.equal(formatPrice(2000, "Free"), "$20");
  assert.equal(formatPrice(9900, "Free"), "$99");
  assert.equal(formatPrice(20000, "Free"), "$200");
});

test("prices with cents show two decimals instead of rounding", () => {
  assert.equal(formatPrice(990, "Free"), "$9.90");
  assert.equal(formatPrice(1980, "Free"), "$19.80");
  assert.equal(formatPrice(999, "Free"), "$9.99");
  assert.equal(formatPrice(5, "Free"), "$0.05");
});

test("zero is the free label", () => {
  assert.equal(formatPrice(0, "Free"), "Free");
});
