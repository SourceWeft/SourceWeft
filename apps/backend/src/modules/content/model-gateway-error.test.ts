import assert from "node:assert/strict";
import { ModelGatewayError } from "../../shared/model-gateway/errors";
import { test } from "vitest";
import { ContentError } from "./errors";
import {
  isRetryableModelContentError,
  sanitizeClientErrorMessage,
  toContentError,
} from "./model-gateway-error";

const rawToolSchemaError =
  'Error invoking tool \'publish_artifact\' with kwargs {"brief":"x","slides":[{"kind":"title"}]} with error: Error: Received tool input did not match expected schema\n\n✖ Invalid input: expected string, received undefined\n  → at title';

test("sanitizeClientErrorMessage hides raw tool kwargs and schema details", () => {
  const message = sanitizeClientErrorMessage(rawToolSchemaError);

  assert.equal(
    message,
    "publish_artifact failed because the generated tool arguments were invalid. Please retry.",
  );
  assert.doesNotMatch(message, /kwargs|schema|brief|slides|expected string/i);
});

test("toContentError sanitizes raw tool invocation errors", () => {
  const error = toContentError(new Error(rawToolSchemaError));

  assert.equal(error.code, "MODEL_UPSTREAM_ERROR");
  assert.equal(
    error.message,
    "publish_artifact failed because the generated tool arguments were invalid. Please retry.",
  );
});

test("toContentError preserves retryable gateway metadata", () => {
  const error = toContentError(
    new ModelGatewayError({
      code: "UPSTREAM",
      message: "Upstream idle timeout exceeded",
      provider: "openai",
      requestId: "req-1",
    }),
  );

  assert.equal(error.code, "MODEL_UPSTREAM_ERROR");
  assert.deepEqual(error.details, {
    gatewayCode: "UPSTREAM",
    retryable: true,
    provider: "openai",
    requestId: "req-1",
  });
  assert.equal(isRetryableModelContentError(error), true);
});

test("retryable model predicate requires explicit retryable metadata on content errors", () => {
  assert.equal(
    isRetryableModelContentError(
      new ContentError(502, "MODEL_UPSTREAM_ERROR", "failed"),
    ),
    false,
  );
  assert.equal(
    isRetryableModelContentError(
      new ContentError(502, "MODEL_UPSTREAM_ERROR", "failed", {
        details: { retryable: true },
      }),
    ),
    true,
  );
});
