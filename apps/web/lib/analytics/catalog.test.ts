import assert from "node:assert/strict";
import { expect, test } from "vitest";

import {
  ANALYTICS_EVENTS,
  ANALYTICS_PARAMS,
  renderGa4Checklist,
  validateEvent,
} from "./catalog";

test("every event param is registered", () => {
  for (const [name, event] of Object.entries(ANALYTICS_EVENTS)) {
    for (const param of event.params) {
      assert.ok(param in ANALYTICS_PARAMS, `${name}.${param} is not registered`);
    }
  }
});

test("stays within GA4 and Umami limits", () => {
  const dimensions = Object.values(ANALYTICS_PARAMS).filter(
    (param) => param.kind === "dimension",
  );
  assert.equal(dimensions.length, 17);
  assert.ok(dimensions.length <= 50);
  for (const name of Object.keys(ANALYTICS_EVENTS)) {
    assert.ok(name.length <= 50, `${name} exceeds 50 characters`);
  }
});

test("validateEvent accepts declared params and context params", () => {
  assert.equal(
    validateEvent("connector_connected", {
      connector_type: "notion",
      platform: "web",
    }),
    null,
  );
});

test("validateEvent rejects unknown events and undeclared params", () => {
  assert.equal(typeof validateEvent("nope", {}), "string");
  assert.equal(typeof validateEvent("login", { email: "x" }), "string");
});

test("validateEvent allows object arrays only for items", () => {
  assert.equal(
    validateEvent("begin_checkout", { items: [{ item_id: "pro_yearly" }] }),
    null,
  );
  assert.equal(typeof validateEvent("login", { method: [{ a: 1 }] }), "string");
});

test("GA4 checklist matches the committed file", async () => {
  await expect(renderGa4Checklist()).toMatchFileSnapshot("./ga4-checklist.md");
});
