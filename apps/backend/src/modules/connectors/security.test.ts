import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestPreview, redactConnectorSecrets } from "./security";

test("redactConnectorSecrets removes nested secret fields", () => {
  assert.deepEqual(
    redactConnectorSecrets({
      accessToken: "secret",
      safe: "value",
      nested: {
        refresh_token: "secret",
        count: 1,
      },
      list: [{ clientSecret: "secret" }],
    }),
    {
      accessToken: "[REDACTED]",
      safe: "value",
      nested: {
        refresh_token: "[REDACTED]",
        count: 1,
      },
      list: [{ clientSecret: "[REDACTED]" }],
    },
  );
});

test("buildRequestPreview prefers explicit action targets", () => {
  assert.equal(
    buildRequestPreview({
      actionType: "fake.item.update",
      request: { externalId: "item-1" },
    }),
    "fake.item.update on item-1",
  );
});
