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

test("a root schema without a type still rejects an extra key", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: {
          additionalProperties: false,
          properties: { folderId: { type: "string" } },
        },
        value: { folderId: "root", extra: "nope" },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("a root schema without a type still enforces required keys", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: {
          required: ["folderId"],
          properties: { folderId: { type: "string" } },
        },
        value: {},
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("an anyOf variant with its own type is enforced", () => {
  const schema = {
    type: "object",
    anyOf: [
      { properties: { mode: { type: "string", enum: ["simple"] } } },
      {
        properties: {
          mode: { type: "string", enum: ["advanced"] },
          detail: { type: "string" },
        },
        required: ["detail"],
      },
    ],
    additionalProperties: false,
    properties: {
      mode: { type: "string" },
      detail: { type: "string" },
    },
  };

  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "requestJson",
      schema,
      value: { mode: "advanced", detail: "x" },
    }),
  );

  // Matches the "advanced" variant's enum but is missing its required
  // "detail", and does not match "simple"'s enum either, so no variant
  // matches overall.
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "requestJson",
        schema,
        value: { mode: "advanced" },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );

  // Fails every variant's own enum check ("simple" vs "advanced"), not just
  // the root's required/additionalProperties.
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "requestJson",
        schema,
        value: { mode: "other" },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );
});

test("an anyOf variant whose own type does not match the value is excluded", () => {
  // Before this fix, anyOf variants were checked only with
  // validateObjectConstraints, which never looks at `type`, so a `{ type:
  // "string" }` variant with no required/properties would silently "match"
  // any object value. This value matches neither variant's real type/shape,
  // so it must still be rejected rather than passing on the string variant.
  const schema = {
    type: "object",
    anyOf: [{ type: "string" }, { type: "object", required: ["ok"] }],
    properties: { ok: { type: "boolean" } },
  };

  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "requestJson",
      schema,
      value: { ok: true },
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

test("reports an invalid pattern in the schema as a schema error", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: {
          type: "object",
          properties: {
            folderId: { type: "string", pattern: "(" },
          },
        },
        value: { folderId: "root" },
      }),
    (error) =>
      error instanceof ConnectorError && error.code === "CONNECTOR_SCHEMA_INVALID",
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

test("existing Drive fileIds config still validates", () => {
  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "configJson",
      schema: driveConfigSchema,
      value: { fileIds: ["1AbCdEfGhIjKlMnOp", "2AbCdEfGhIjKlMnOp"] },
    }),
  );
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

// Shaped exactly like the Dropbox connector's configSchema (global
// constraints: `{ items: [{ id: "id:…", kind: "file" | "folder" }] }`,
// maxItems 500, item id pattern `^id:[A-Za-z0-9_-]{1,200}$`). Inlined for the
// same reason the Drive schema above is: this host test exercises the
// validator's generic recursion, not the capability package, and must not
// import it (src/architecture-capability-imports.test.ts). This is the first
// contribution schema whose array `items` are themselves `type: "object"`, so
// it closes the gap this task fixes: nested object constraints
// (`required`/`additionalProperties`/`properties`) were only enforced at the
// top level before this task.
const dropboxConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        required: ["id", "kind"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^id:[A-Za-z0-9_-]{1,200}$" },
          kind: { type: "string", enum: ["file", "folder"] },
        },
      },
    },
  },
};

test("nested item objects enforce required and additionalProperties", () => {
  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: dropboxConfigSchema,
        value: { items: [{ id: "id:abc" }] },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );

  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: dropboxConfigSchema,
        value: { items: [{ id: "id:abc", kind: "file", extra: "nope" }] },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );

  assert.throws(
    () =>
      validateObjectWithJsonSchema({
        label: "configJson",
        schema: dropboxConfigSchema,
        value: { items: [{ id: "id:abc", kind: "dir" }] },
      }),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_SCHEMA_VALIDATION_FAILED",
  );

  assert.doesNotThrow(() =>
    validateObjectWithJsonSchema({
      label: "configJson",
      schema: dropboxConfigSchema,
      value: { items: [{ id: "id:abc", kind: "file" }] },
    }),
  );
});
