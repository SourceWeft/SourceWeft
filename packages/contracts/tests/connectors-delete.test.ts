import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteConnectorAccountRequestSchema,
  deleteConnectorAccountResponseSchema,
  deleteConnectorRequestSchema,
  deleteConnectorResponseSchema,
} from "../src/connectors";

test("delete connector request defaults to keeping indexed content", () => {
  assert.deepEqual(deleteConnectorRequestSchema.parse({}), {});
  assert.deepEqual(deleteConnectorRequestSchema.parse({
    purgeIndexedContent: true,
  }), {
    purgeIndexedContent: true,
  });
});

test("delete connector response captures purge outcome and counts", () => {
  assert.deepEqual(
    deleteConnectorResponseSchema.parse({
      deleted: true,
      connectorId: "connector_1",
      indexedContentDeleted: true,
      sourcesDeleted: 2,
      documentsDeleted: 3,
      providerRevokeWarning: "Provider revoke failed",
    }),
    {
      deleted: true,
      connectorId: "connector_1",
      indexedContentDeleted: true,
      sourcesDeleted: 2,
      documentsDeleted: 3,
      providerRevokeWarning: "Provider revoke failed",
    },
  );
});

test("delete connector account request and response support force detach", () => {
  assert.deepEqual(deleteConnectorAccountRequestSchema.parse({ force: true }), {
    force: true,
  });
  assert.deepEqual(
    deleteConnectorAccountResponseSchema.parse({
      deleted: true,
      accountId: "account_1",
      accountStatus: "revoked",
      detachedConnectorIds: ["connector_1"],
      providerRevokeWarning: null,
    }),
    {
      deleted: true,
      accountId: "account_1",
      accountStatus: "revoked",
      detachedConnectorIds: ["connector_1"],
      providerRevokeWarning: null,
    },
  );
});
