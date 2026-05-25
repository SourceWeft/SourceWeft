import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeConnectorConfigJson,
  validateObjectWithJsonSchema,
} from "./config-validation";
import { ConnectorError } from "./errors";

test("validateObjectWithJsonSchema accepts a matching object", () => {
  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "configJson",
      schema: {
        type: "object",
        required: ["folderId"],
        additionalProperties: false,
        properties: {
          folderId: { type: "string" },
          includeArchived: { type: "boolean" },
        },
      },
      value: {
        folderId: "root",
        includeArchived: false,
      },
    }),
  );
});

test("validateObjectWithJsonSchema rejects missing required keys", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: {
          type: "object",
          required: ["folderId"],
          properties: {
            folderId: { type: "string" },
          },
        },
        value: {},
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("validateObjectWithJsonSchema rejects additional properties when disabled", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        value: { token: "not allowed" },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("validateObjectWithJsonSchema accepts anyOf object variants", () => {
  const schema = {
    type: "object",
    anyOf: [{ required: ["pageId"] }, { required: ["pageIds"] }],
    additionalProperties: false,
    properties: {
      pageId: { type: "string" },
      pageIds: { type: "array" },
    },
  };

  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "requestJson",
      schema,
      value: { pageIds: ["page_1", "page_2"] },
    }),
  );
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "requestJson",
        schema,
        value: {},
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("normalizeConnectorConfigJson strips deprecated Notion config fields", () => {
  const input = {
    includePages: true,
    includeDataSources: true,
    includeDatabases: true,
    notionApiVersion: "2026-03-11",
  };
  const normalized = normalizeConnectorConfigJson({
    connectorType: "notion",
    value: input,
  });

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.value, { includePages: true });
  assert.notEqual(normalized.value, input);
  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "configJson",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          includePages: { type: "boolean" },
        },
      },
      value: normalized.value,
    }),
  );
});

test("normalizeConnectorConfigJson keeps unrelated unknown config fields visible", () => {
  const normalized = normalizeConnectorConfigJson({
    connectorType: "notion",
    value: {
      includePages: true,
      unknownFlag: true,
    },
  });

  assert.equal(normalized.changed, false);
  assert.deepEqual(normalized.value, {
    includePages: true,
    unknownFlag: true,
  });
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            includePages: { type: "boolean" },
          },
        },
        value: normalized.value,
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});
