import assert from "node:assert/strict";
import { test } from "vitest";
import {
  sanitizeClientErrorMessage,
  toContentServiceError,
} from "./model-gateway-error";

const rawToolSchemaError =
  'Error invoking tool \'generate_pptx\' with kwargs {"brief":"x","slides":[{"kind":"title"}]} with error: Error: Received tool input did not match expected schema\n\n✖ Invalid input: expected string, received undefined\n  → at title';

test("sanitizeClientErrorMessage hides raw tool kwargs and schema details", () => {
  const message = sanitizeClientErrorMessage(rawToolSchemaError);

  assert.equal(
    message,
    "generate_pptx failed because the generated tool arguments were invalid. Please retry.",
  );
  assert.doesNotMatch(message, /kwargs|schema|brief|slides|expected string/i);
});

test("toContentServiceError sanitizes raw tool invocation errors", () => {
  const error = toContentServiceError(new Error(rawToolSchemaError));

  assert.equal(error.code, "MODEL_UPSTREAM_ERROR");
  assert.equal(
    error.message,
    "generate_pptx failed because the generated tool arguments were invalid. Please retry.",
  );
});
