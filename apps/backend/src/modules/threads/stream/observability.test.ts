import assert from "node:assert/strict";
import { test } from "vitest";
import { ModelGatewayError } from "../../../shared/model-gateway/errors";
import { ContentError } from "../../content/errors";
import { toContentError } from "../../content/model-gateway-error";
import { toObservationError } from "./observability";

test("stream observations preserve safe configuration failures", () => {
  const gatewayError = new ModelGatewayError({
    code: "CONFIGURATION",
    message: "No ready target: private-provider private-secret",
  });
  for (const source of [
    gatewayError,
    new Error("MiddlewareError", { cause: gatewayError }),
    {
      error: {
        code: "CONFIGURATION",
        message: gatewayError.message,
        retryable: false,
      },
    },
  ]) {
    const mapped = toContentError(source);
    const error = toObservationError(source);
    assert.equal(error.code, "MODEL_CONFIGURATION_ERROR");
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, mapped.message);
    assert.doesNotMatch(error.message, /private-provider|private-secret/);
  }
  const existing = new ContentError(
    403,
    "THREAD_FORBIDDEN",
    "Thread access denied",
  );
  assert.equal(toObservationError(existing), existing);
});
