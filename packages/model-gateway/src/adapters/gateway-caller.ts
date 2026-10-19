import { AsyncCaller } from "@langchain/core/utils/async_caller";
import { ModelGatewayError, normalizeGatewayError } from "../errors";
import { isUnparsedStructuredAnswer } from "../structured-output-errors";
import type { AdapterRequestOptions } from "./types";

/** Preserve LangChain's status/quota rules, adding host policy and cancellation. */
export class GatewayCaller extends AsyncCaller {
  private failedAttempts = 0;

  private startedAtMs = Date.now();

  private inFlight = 0;

  constructor(options?: AdapterRequestOptions) {
    super({ maxRetries: options?.maxRetries ?? 2 });
    const defaultHandler = this.onFailedAttempt;
    const retryLog = options?.retryLog;
    this.onFailedAttempt = (error: unknown) => {
      const normalized = normalizeGatewayError(error);
      if (normalized.code === "POLICY") throw normalized;
      // An abort is the caller's or the attempt guard's decision, not a
      // provider failure to report as a retry.
      options?.signal?.throwIfAborted();
      // Every failed provider attempt is visible, whether or not it is
      // retried: a run that failed after N silent retries was otherwise
      // indistinguishable from one that failed once.
      this.failedAttempts += 1;
      retryLog?.logger.warn?.("model-gateway.retry", {
        attempt: this.failedAttempts,
        maxRetries: this.maxRetries,
        // The last allowed attempt is reported too; this says whether another
        // follows (the agent stack sets maxRetries 0 and retries itself).
        willRetry: this.failedAttempts <= (this.maxRetries ?? 0),
        errorCode: normalized.code,
        elapsedMs: Date.now() - this.startedAtMs,
        provider: retryLog.provider,
        providerModel: retryLog.providerModel,
      });
      if (
        (ModelGatewayError.isInstance(error) && !error.retryable) ||
        (error instanceof Error &&
          error.name === "GoogleGenerativeAIAbortError") ||
        // The SDK parses a json_schema answer inside this retried call; an
        // answer it rejects was received (and billed), so it goes to the
        // caller instead of being requested again here.
        isUnparsedStructuredAnswer(error)
      )
        throw error;
      return defaultHandler?.(error);
    };
  }

  // AsyncCaller hands onFailedAttempt the bare error, without p-retry's
  // attempt context, so attempts are counted here per call sequence.
  override async call<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    A extends any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends (...args: A) => Promise<any>,
  >(callable: T, ...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> {
    if (this.inFlight === 0) {
      this.failedAttempts = 0;
      this.startedAtMs = Date.now();
    }
    this.inFlight += 1;
    try {
      return (await super.call(callable, ...args)) as Awaited<ReturnType<T>>;
    } finally {
      this.inFlight -= 1;
    }
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
