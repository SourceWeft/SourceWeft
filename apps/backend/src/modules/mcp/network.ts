import { config } from "../../shared/config";
import { createControlledFetch } from "../../shared/security/controlled-fetch";
import { EndpointPolicyError } from "../../shared/security/endpoint-policy";
import { McpError } from "./errors";

export function createMcpRequestScope() {
  const requests = createControlledFetch({
    enforceAddressChecks: config.endpointAddressChecksEnabled,
    allowedInternalOrigins: config.mcpAllowedInternalOrigins ?? [],
  });
  return {
    ...requests,
    throwIfDenied() {
      try {
        requests.throwIfDenied();
      } catch (error) {
        if (error instanceof EndpointPolicyError)
          throw new McpError(400, "MCP_ENDPOINT_BLOCKED", error.message);
        throw error;
      }
    },
  };
}

/** Application deadlines for the OAuth operations that run before a redirect. */
export const MCP_OAUTH_START_DEADLINE_MS = 20_000;
export const MCP_OAUTH_EXCHANGE_DEADLINE_MS = 20_000;

/**
 * Run `work` with a deadline that aborts its in-flight requests, not just the
 * wait for them: every fetch handed to `work` carries the deadline's signal,
 * which the controlled fetch passes to each hop, so discovery, registration
 * and token exchange stop when it fires. Rejects with `timeoutError` (an
 * McpError) on expiry. `work` that is still running is not awaited again; its
 * late failure is swallowed so it cannot surface as an unhandled rejection. The
 * signal is also handed to `work`, which must check it before any write whose
 * effect outlives the operation.
 */
export async function withMcpRequestDeadline<T>(
  requests: ReturnType<typeof createMcpRequestScope>,
  options: { ms: number; timeoutError: () => McpError },
  work: (
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const fetchWithDeadline: typeof globalThis.fetch = (input, init) =>
    requests.fetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal,
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(options.timeoutError());
    }, options.ms);
  });
  const running = work(fetchWithDeadline, controller.signal);
  running.catch(() => undefined);
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
  }
}
