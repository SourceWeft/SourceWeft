import assert from "node:assert/strict";
import { test } from "vitest";
import { mailDeliveryConfigured } from "./delivery";

test("the default provider delivers nothing, so nothing may wait on an email", () => {
  for (const provider of ["console", "noop", "Console", " NOOP "]) {
    assert.equal(mailDeliveryConfigured(provider), false, provider);
  }
});

test("a real provider means verification can be asked for", () => {
  assert.equal(mailDeliveryConfigured("plunk"), true);
});
