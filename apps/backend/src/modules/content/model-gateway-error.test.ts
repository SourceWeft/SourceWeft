import assert from "node:assert/strict";
import { ModelGatewayError } from "../../shared/model-gateway/errors";
import { test } from "vitest";
import { ContentError } from "./errors";
import { toApiError } from "../../api/response/api-response";
import {
  isRetryableModelContentError,
  sanitizeClientErrorMessage,
  toContentError,
} from "./model-gateway-error";

const rawToolSchemaError =
  'Error invoking tool \'publish_artifact\' with kwargs {"brief":"x","slides":[{"kind":"title"}]} with error: Error: Received tool input did not match expected schema\n\n✖ Invalid input: expected string, received undefined\n  → at title';

test("sanitizeClientErrorMessage hides database query text and parameters", () => {
  const message = sanitizeClientErrorMessage(
    "Failed query: insert into messages (...)\nparams: private-request-value",
  );
  assert.equal(message, "The request could not be saved. Please try again.");
  assert.doesNotMatch(message, /insert|messages|params|private-request-value/);
});

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

for (const wrapper of ["direct", "cause", "serialized"] as const) {
  test(`configuration failure maps safely and is non-retryable through ${wrapper}`, () => {
    const gatewayError = new ModelGatewayError({
      code: "CONFIGURATION",
      message:
        "No globally ready route: private-route https://private.internal key=private-secret",
      retryable: false,
    });
    const source =
      wrapper === "direct"
        ? gatewayError
        : wrapper === "cause"
          ? new Error("MiddlewareError", { cause: gatewayError })
          : {
              error: {
                code: gatewayError.code,
                message: gatewayError.message,
                retryable: false,
              },
            };
    const error = toContentError(source);
    assert.equal(error.code, "MODEL_CONFIGURATION_ERROR");
    assert.equal(error.statusCode, 503);
    const apiError = toApiError(error);
    assert.equal(apiError.code, error.code);
    assert.equal(apiError.statusCode, error.statusCode);
    assert.equal(apiError.message, error.message);
    assert.equal(error.recoverable, false);
    assert.equal(
      error.message,
      "No model is available for this request. Ask an administrator to check the model provider and route configuration.",
    );
    assert.deepEqual(error.details, {
      gatewayCode: "CONFIGURATION",
      retryable: false,
    });
    assert.equal(isRetryableModelContentError(source), false);
    assert.equal(isRetryableModelContentError(error), false);
    assert.doesNotMatch(
      JSON.stringify({ message: error.message, details: error.details }),
      /private-route|private\.internal|private-secret/,
    );
  });
}

for (const statusCode of [401, 403]) {
  test(`provider HTTP ${statusCode} remains authentication failure in the content mapping`, () => {
    const error = toContentError(
      new ModelGatewayError({
        code: "AUTH",
        statusCode,
        // Classification is exclusively by error code, not message matching.
        message: "No globally ready route target is configured",
      }),
    );
    assert.equal(error.code, "MODEL_GATEWAY_AUTH_ERROR");
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, "Model gateway authentication failed");
    assert.equal(isRetryableModelContentError(error), false);
    assert.deepEqual(error.details, {
      gatewayCode: "AUTH",
      retryable: false,
      statusCode,
    });
  });
}
