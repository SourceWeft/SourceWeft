import type { LiteLLMRequestMetadata, RequestOptions } from "../types";

export function buildTracingMetadata(
  metadata: LiteLLMRequestMetadata | undefined,
  options: RequestOptions | undefined,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    ...defaults,
    ...(metadata ?? {}),
    ...(options?.metadata ?? {}),
  };

  if (options?.traceId) {
    output.trace_id = options.traceId;
  }

  if (options?.tags && options.tags.length > 0) {
    output.tags = options.tags;
  }

  return output;
}

export function buildTracingHeaders(
  options?: RequestOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options?.traceId) {
    headers["X-Trace-Id"] = options.traceId;
  }
  return headers;
}
