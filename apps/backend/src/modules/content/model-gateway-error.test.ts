import assert from "node:assert/strict";
import { test } from "vitest";
import {
  sanitizeClientErrorMessage,
  toContentError,
} from "./model-gateway-error";

const rawToolSchemaError =
  'Error invoking tool \'publish_sandbox_artifact\' with kwargs {"brief":"x","slides":[{"kind":"title"}]} with error: Error: Received tool input did not match expected schema\n\n✖ Invalid input: expected string, received undefined\n  → at title';

test("sanitizeClientErrorMessage hides raw tool kwargs and schema details", () => {
  const message = sanitizeClientErrorMessage(rawToolSchemaError);

  assert.equal(
    message,
    "publish_sandbox_artifact failed because the generated tool arguments were invalid. Please retry.",
  );
  assert.doesNotMatch(message, /kwargs|schema|brief|slides|expected string/i);
});

test("toContentError sanitizes raw tool invocation errors", () => {
  const error = toContentError(new Error(rawToolSchemaError));

  assert.equal(error.code, "MODEL_UPSTREAM_ERROR");
  assert.equal(
    error.message,
    "publish_sandbox_artifact failed because the generated tool arguments were invalid. Please retry.",
  );
});
