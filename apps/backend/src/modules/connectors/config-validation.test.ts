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

// Shaped exactly like the Google Drive connector's configSchema (spec 3.3,
// packages/builtin-connector-google-drive/src/contribution.ts). Inlined
// rather than imported: this host test is about the validator's generic
// keyword support, not about that capability, and the host must not depend on
// a capability package's names (src/architecture-capability-imports.test.ts).
// This is the first contribution schema to declare maxItems, uniqueItems, and
// a per-item pattern, so it closes a real gap in the validator. It
// incidentally starts enforcing Gmail's already-declared `labelIds`
// maxItems: 20 too (see the Gmail service tests).
const driveConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    fileIds: {
      type: "array",
      maxItems: 500,
      uniqueItems: true,
      items: {
        type: "string",
        pattern: "^[A-Za-z0-9_-]{10,200}$",
      },
    },
  },
};

test("accepts a valid Drive selection", () => {
  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "configJson",
      schema: driveConfigSchema,
      value: { fileIds: ["1AbCdEfGhIjKlMnOp"] },
    }),
  );
});

test("accepts an empty Drive selection", () => {
  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "configJson",
      schema: driveConfigSchema,
      value: { fileIds: [] },
    }),
  );
});

test("rejects more than 500 file ids", () => {
  const fileIds = Array.from(
    { length: 501 },
    (_, index) => `file${String(index).padStart(6, "0")}`,
  );
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: driveConfigSchema,
        value: { fileIds },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("rejects duplicate file ids", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: driveConfigSchema,
        value: { fileIds: ["1AbCdEfGhIjKlMnOp", "1AbCdEfGhIjKlMnOp"] },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("rejects a malformed file id", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: driveConfigSchema,
        value: { fileIds: ["../etc"] },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("rejects unknown config keys", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: driveConfigSchema,
        value: { fileIds: [], folderIds: [] },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});
