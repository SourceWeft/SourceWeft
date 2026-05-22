import assert from "node:assert/strict";
import { test } from "vitest";
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

test("redactConnectorSecrets redacts signed URL query fields", () => {
  assert.deepEqual(
    redactConnectorSecrets({
      url: "https://s3.example.com/file.pdf?X-Amz-Signature=secret&X-Amz-Credential=key&safe=1",
    }),
    {
      url: "https://s3.example.com/file.pdf?X-Amz-Signature=%5BREDACTED%5D&X-Amz-Credential=%5BREDACTED%5D&safe=1",
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
