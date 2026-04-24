import type { GatewayRequestMetadata, RequestOptions } from "../types";

export function buildTracingMetadata(
  metadata: GatewayRequestMetadata | undefined,
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

function randomId(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    const charIndex = Math.floor(Math.random() * alphabet.length);
    output += alphabet[charIndex];
  }
  return output;
}

export function createSpanIds(options?: RequestOptions): {
  traceId?: string;
  spanId: string;
} {
  return {
    traceId: options?.traceId,
    spanId: randomId(16),
  };
}
