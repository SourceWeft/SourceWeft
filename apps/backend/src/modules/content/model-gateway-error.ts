import { ModelGatewayError } from "@sourceweft/model-gateway";
import { ContentError } from "./errors";

export function toContentServiceError(error: unknown): ContentError {
  if (!ModelGatewayError.isInstance(error)) {
    return new ContentError(502, "MODEL_UPSTREAM_ERROR", "LLM request failed");
  }

  const gatewayError = error as ModelGatewayError;

  if (gatewayError.code === "BAD_REQUEST") {
    return new ContentError(400, "MODEL_REQUEST_INVALID", gatewayError.message);
  }

  if (gatewayError.code === "RATE_LIMIT") {
    return new ContentError(
      429,
      "MODEL_RATE_LIMITED",
      "LLM provider rate limit reached",
    );
  }

  if (gatewayError.code === "TIMEOUT") {
    return new ContentError(504, "MODEL_TIMEOUT", "LLM request timed out");
  }

  if (gatewayError.code === "AUTH") {
    return new ContentError(
      502,
      "MODEL_GATEWAY_AUTH_ERROR",
      "Model gateway authentication failed",
    );
  }

  return new ContentError(502, "MODEL_UPSTREAM_ERROR", gatewayError.message);
}
