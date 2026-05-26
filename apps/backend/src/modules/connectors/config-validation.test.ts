import assert from "node:assert/strict";
import { test } from "vitest";
import { validateObjectWithJsonSchema } from "./config-validation";
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
