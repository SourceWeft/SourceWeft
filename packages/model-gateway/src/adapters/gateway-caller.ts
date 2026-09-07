import { AsyncCaller } from "@langchain/core/utils/async_caller";
import { ModelGatewayError, normalizeGatewayError } from "../errors";
import type { AdapterRequestOptions } from "./types";

/** Preserve LangChain's status/quota rules, adding host policy and cancellation. */
export class GatewayCaller extends AsyncCaller {
  constructor(options?: AdapterRequestOptions) {
    super({ maxRetries: options?.maxRetries ?? 2 });
    const defaultHandler = this.onFailedAttempt;
    this.onFailedAttempt = (error: unknown) => {
      const normalized = normalizeGatewayError(error);
      if (normalized.code === "POLICY") throw normalized;
      options?.signal?.throwIfAborted();
      if (
        (ModelGatewayError.isInstance(error) && !error.retryable) ||
        (error instanceof Error &&
          error.name === "GoogleGenerativeAIAbortError")
      )
        throw error;
      return defaultHandler?.(error);
    };
  }

  get params() {
    return {
      maxRetries: this.maxRetries,
      onFailedAttempt: this.onFailedAttempt,
    };
  }
}

// Constructor parameters propagate to ChatOpenAI's public Completions/Responses
// models too; replacing only the outer model.caller would leave those unguarded.
export function sdkRetryOptions(options?: AdapterRequestOptions) {
  return new GatewayCaller(options).params;
}
