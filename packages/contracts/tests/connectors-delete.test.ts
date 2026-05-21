import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteConnectorAccountRequestSchema,
  deleteConnectorAccountResponseSchema,
  deleteConnectorRequestSchema,
  deleteConnectorResponseSchema,
  listConnectorsRequestSchema,
} from "../src/connectors";

test("delete connector request defaults to hard delete", () => {
  assert.deepEqual(deleteConnectorRequestSchema.parse({}), {});
  assert.deepEqual(
    deleteConnectorRequestSchema.parse({
      disable: true,
    }),
    {
      disable: true,
    },
  );
});

test("delete connector response captures hard delete outcome and counts", () => {
  assert.deepEqual(
    deleteConnectorResponseSchema.parse({
      disabled: false,
      hardDeleted: true,
      connectorId: "connector_1",
      indexedContentDeleted: true,
      sourcesDeleted: 2,
      documentsDeleted: 3,
      authorizationDeleted: true,
    }),
    {
      disabled: false,
      hardDeleted: true,
      connectorId: "connector_1",
      indexedContentDeleted: true,
      sourcesDeleted: 2,
      documentsDeleted: 3,
      authorizationDeleted: true,
    },
  );
});

test("delete connector account request and response do not force detach", () => {
  assert.deepEqual(deleteConnectorAccountRequestSchema.parse({}), {});
  assert.deepEqual(
    deleteConnectorAccountResponseSchema.parse({
      deleted: true,
      accountId: "account_1",
    }),
    {
      deleted: true,
      accountId: "account_1",
    },
  );
});

test("list connectors request can opt into disabled records", () => {
  assert.deepEqual(listConnectorsRequestSchema.parse({}), {});
  assert.deepEqual(
    listConnectorsRequestSchema.parse({ includeDisabled: true }),
    { includeDisabled: true },
  );
});
