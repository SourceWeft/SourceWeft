import type { GatewayErrorCode, GatewayErrorData } from "./types";
import { isRecord } from "./utils/object";

const RETRYABLE_CODES: ReadonlySet<GatewayErrorCode> = new Set([
  "TIMEOUT",
  "RATE_LIMIT",
  "UPSTREAM",
  // DeepSeek's own JSON-mode docs admit the occasional empty response; one
  // more attempt against the same target is legitimate. What is NOT legitimate
  // is walking the failover chain with it — see FAILOVERABLE_CODES.
  "STRUCTURED_OUTPUT",
]);

/**
 * Orthogonal to `retryable`. `retryable` asks "would the same provider succeed
 * on a second attempt?" — true for transient faults (timeouts, 429s, 5xx),
 * false for a drained balance. This set asks "could a *different* provider
 * serve this request?" — which is also true for QUOTA (the other provider has
 * its own balance) and AUTH (its own key). Only errors caused by the request
 * itself (BAD_REQUEST, POLICY) fail everywhere, so they must not burn a
 * wasted attempt against every target in the route.
 */
const FAILOVERABLE_CODES: ReadonlySet<GatewayErrorCode> = new Set([
  "TIMEOUT",
  "RATE_LIMIT",
  "UPSTREAM",
  "QUOTA",
  "AUTH",
]);

/**
 * Failures that describe the *account behind a target*, not the request:
 * a drained balance (QUOTA) or a dead key (AUTH). They may consume a failover
 * hop, but they must never *represent* the request's failure while any target
 * produced a substantive error — a tail target that happens to be unfunded
 * would otherwise mask the real cause (a 402 hiding an empty structured
 * output was a production incident). See {@link selectSurfacedFailoverError}.
 */
const ADMINISTRATIVE_CODES: ReadonlySet<GatewayErrorCode> = new Set([
  "QUOTA",
  "AUTH",
]);

export function isAdministrativeGatewayCode(code: GatewayErrorCode): boolean {
  return ADMINISTRATIVE_CODES.has(code);
}

export class ModelGatewayError extends Error {
  readonly code: GatewayErrorCode;

  readonly retryable: boolean;

  readonly statusCode?: number;

  readonly provider?: string;

  readonly requestId?: string;

  readonly metadata?: Record<string, unknown>;

  constructor(input: {
    code: GatewayErrorCode;
    message: string;
    retryable?: boolean;
    statusCode?: number;
    provider?: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "ModelGatewayError";
    this.code = input.code;
    this.retryable = input.retryable ?? RETRYABLE_CODES.has(input.code);
    this.statusCode = input.statusCode;
    this.provider = input.provider;
    this.requestId = input.requestId;
    this.metadata = input.metadata;
    if (input.cause !== undefined) {
      (this as { cause?: unknown }).cause = input.cause;
    }
  }

  static isInstance(value: unknown): value is ModelGatewayError {
    return value instanceof ModelGatewayError;
  }
}

function mapStatusCodeToErrorCode(statusCode: number): GatewayErrorCode {
  if (statusCode === 401 || statusCode === 403) {
    return "AUTH";
  }
  if (statusCode === 402) {
    return "QUOTA";
  }
  if (statusCode === 429) {
    return "RATE_LIMIT";
  }
  if (statusCode >= 400 && statusCode < 500) {
    return "BAD_REQUEST";
  }
  if (statusCode >= 500) {
    return "UPSTREAM";
  }
  return "UNKNOWN";
}

function extractMessageFromBody(body: unknown, fallback: string): string {
  if (!isRecord(body)) {
    return fallback;
  }

  const bodyMessage =
    (isRecord(body.error) &&
      typeof body.error.message === "string" &&
      body.error.message) ||
    (typeof body.message === "string" && body.message) ||
    fallback;

  return bodyMessage;
}

function extractProviderFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  if (typeof body.provider === "string" && body.provider.length > 0) {
    return body.provider;
  }

  if (isRecord(body.error) && typeof body.error.type === "string") {
    return body.error.type;
  }

  return undefined;
}

export function createHttpGatewayError(input: {
  statusCode: number;
  body?: unknown;
  requestId?: string;
}): ModelGatewayError {
  const { statusCode, body, requestId } = input;
  const code = mapStatusCodeToErrorCode(statusCode);
  const fallbackMessage = `Model gateway request failed with status ${statusCode}`;
  const message = extractMessageFromBody(body, fallbackMessage);

  return new ModelGatewayError({
    code,
    message,
    statusCode,
    provider: extractProviderFromBody(body),
    requestId,
    metadata: isRecord(body) ? body : undefined,
  });
}

export function normalizeGatewayError(error: unknown): ModelGatewayError {
  if (ModelGatewayError.isInstance(error)) {
    return error;
  }

  if (
    isRecord(error) &&
    (error.name === "AbortError" || error.name === "TimeoutError") &&
    typeof error.message === "string"
  ) {
    return new ModelGatewayError({
      code: "TIMEOUT",
      message: error.message || "Model gateway request timed out",
      retryable: true,
      cause: error,
    });
  }

  // Provider SDK errors (OpenAI-compatible clients, LangChain wrappers) carry
  // the HTTP status but are not ModelGatewayErrors. Without this extraction a
  // 402 or 400 would fall through to the generic branch below and be labelled
  // a retryable UPSTREAM fault — misclassifying both retry and failover.
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined && isRecord(error) && typeof error.message === "string") {
    return new ModelGatewayError({
      code: mapStatusCodeToErrorCode(statusCode),
      message: error.message,
      statusCode,
      cause: error,
    });
  }

  if (isRecord(error) && typeof error.message === "string") {
    return new ModelGatewayError({
      code: "UPSTREAM",
      message: error.message,
      retryable: true,
      cause: error,
    });
  }

  return new ModelGatewayError({
    code: "UNKNOWN",
    message: "Unknown model gateway error",
    retryable: false,
    cause: error,
  });
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const candidates = [
    error.status,
    error.statusCode,
    isRecord(error.response) ? error.response.status : undefined,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate < 600
    ) {
      return candidate;
    }
  }
  return undefined;
}

export function isRetryableError(error: unknown): boolean {
  return normalizeGatewayError(error).retryable;
}

/**
 * Whether switching to another route target could rescue this request. See
 * FAILOVERABLE_CODES for the retryable-vs-failoverable distinction. Callers
 * must additionally check that the failure is not a caller-initiated abort
 * (`options.signal.aborted`) — a cancelled request must never be replayed
 * against another provider.
 */
export function isFailoverableError(error: unknown): boolean {
  return isFailoverableCode(normalizeGatewayError(error).code);
}

/**
 * Code-level variant for failures that arrive as already-classified data
 * rather than thrown errors — e.g. a chat stream's terminal error event.
 */
export function isFailoverableCode(code: GatewayErrorCode): boolean {
  return FAILOVERABLE_CODES.has(code);
}

export function toGatewayErrorData(error: unknown): GatewayErrorData {
  const normalized = normalizeGatewayError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    statusCode: normalized.statusCode,
    provider: normalized.provider,
    requestId: normalized.requestId,
  };
}

/** One failed target attempt, as the failover loops collect them. */
export type TargetAttemptError = {
  provider: string;
  providerModel: string;
  error: unknown;
};

/**
 * Canonical model identity across gateways. Aggregators prefix the same model
 * with an org path ("deepseek-v4-pro" direct vs "deepseek/deepseek-v4-pro" on
 * OpenRouter/Cloudflare), so "same model?" must compare the final path
 * segment, case-insensitively — a raw string comparison let a model-level
 * failure walk every channel of the very model that just failed.
 */
export function canonicalProviderModel(providerModel: string): string {
  const segments = providerModel.split("/");
  return (segments[segments.length - 1] ?? providerModel).trim().toLowerCase();
}

/**
 * How much a failure explains about *this request*, for choosing which of a
 * chain's errors to surface. Substantive failures outrank administrative ones
 * (see ADMINISTRATIVE_CODES); among substantive ones, the more the code says
 * about the request itself, the higher it ranks. Ties keep the earliest
 * attempt — the primary target's account of the failure.
 */
const SURFACED_ERROR_RANK: Record<GatewayErrorCode, number> = {
  STRUCTURED_OUTPUT: 7,
  BAD_REQUEST: 6,
  POLICY: 6,
  UPSTREAM: 5,
  TIMEOUT: 4,
  RATE_LIMIT: 3,
  UNKNOWN: 2,
  QUOTA: 1,
  AUTH: 1,
};

/**
 * Code-level variant of the surfacing rank, for failures that arrive as
 * already-classified data rather than thrown errors (a chat stream's terminal
 * error events). Higher = more informative about the request.
 */
export function surfacedErrorRankForCode(code: GatewayErrorCode): number {
  return SURFACED_ERROR_RANK[code];
}

/** Compact, log/metadata-safe summary of every attempt in a failed chain. */
export function summarizeTargetErrors(attempts: readonly TargetAttemptError[]) {
  return attempts.map((attempt) => {
    const normalized = normalizeGatewayError(attempt.error);
    return {
      provider: attempt.provider,
      providerModel: attempt.providerModel,
      code: normalized.code,
      ...(normalized.statusCode !== undefined
        ? { statusCode: normalized.statusCode }
        : {}),
      message: normalized.message.slice(0, 200),
    };
  });
}

/**
 * The error a failover-exhausted chain should surface: the most informative
 * one, not the last one. With a single attempt the original error passes
 * through untouched (identity preserved for callers that inspect it). With
 * several, the highest-ranked error wins; when it is a ModelGatewayError it is
 * re-issued with a `targetErrors` summary of the whole chain merged into its
 * metadata (original as `cause`), so no attempt's failure is lost — while a
 * raw provider error is surfaced as-is and the summary is left to the
 * caller's failover log.
 */
export function selectSurfacedFailoverError(
  attempts: readonly TargetAttemptError[],
): unknown {
  if (attempts.length === 0) {
    return new ModelGatewayError({
      code: "UNKNOWN",
      message: "Model gateway failover exhausted with no recorded attempts",
      retryable: false,
    });
  }
  if (attempts.length === 1) {
    return attempts[0]!.error;
  }

  let best = attempts[0]!;
  let bestRank = SURFACED_ERROR_RANK[normalizeGatewayError(best.error).code];
  for (const attempt of attempts.slice(1)) {
    const rank = SURFACED_ERROR_RANK[normalizeGatewayError(attempt.error).code];
    if (rank > bestRank) {
      best = attempt;
      bestRank = rank;
    }
  }

  const surfaced = best.error;
  if (!ModelGatewayError.isInstance(surfaced)) {
    return surfaced;
  }
  return new ModelGatewayError({
    code: surfaced.code,
    message: surfaced.message,
    retryable: surfaced.retryable,
    statusCode: surfaced.statusCode,
    provider: surfaced.provider,
    requestId: surfaced.requestId,
    metadata: {
      ...surfaced.metadata,
      targetErrors: summarizeTargetErrors(attempts),
    },
    cause: surfaced,
  });
}
