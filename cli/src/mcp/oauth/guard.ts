import { McpInspectError } from "../../errors";
import { checkTarget, isLoopbackHost } from "./trust";

/**
 * Binds requests to where they belong, and bounds them in time.
 *
 * `createCredentialedFetch` carries tokens (the access token to the endpoint,
 * the code or refresh token to the token endpoint): it sends only to the
 * origins it was made for and never follows a redirect off them.
 * `createOpenFetch` carries nothing secret (discovery, registration, the
 * unauthenticated probe): it still checks every target (https, no private
 * hosts) and every redirect hop, and follows redirects only where that is
 * safe. Both stop on the caller's abort signal and after a time limit.
 */

const MAX_REDIRECTS = 3;
/** One request, from the first byte sent to the last byte read. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** https, or http on the machine itself (development servers, tests). */
export function isSecureOrigin(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHost(url.hostname))
  );
}

type FetchImpl = typeof fetch;

export type FetchLimits = {
  fetchImpl?: FetchImpl;
  /** Ends every request when it fires (Ctrl-C). */
  signal?: AbortSignal;
  timeoutMs?: number;
};

function targetOf(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

/** One signal that fires when any of `signals` does. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/** Runs one request under the abort signal and the time limit. */
async function limited(
  limits: FetchLimits,
  target: URL,
  run: (signal: AbortSignal) => Promise<Response>,
  callerSignal?: AbortSignal | null,
): Promise<Response> {
  const timeoutMs = limits.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = anySignal(
    [limits.signal, callerSignal, timeout].filter(
      (item): item is AbortSignal => item !== undefined && item !== null,
    ),
  );
  try {
    return await run(signal);
  } catch (error) {
    if (limits.signal?.aborted) {
      throw new McpInspectError("The sign-in was cancelled.");
    }
    if (timeout.aborted) {
      throw new McpInspectError(
        `${target.origin} did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s.`,
      );
    }
    throw error;
  }
}

function redirectTarget(response: Response, from: URL): URL | undefined {
  const location = response.headers.get("location");
  if (!location) return undefined;
  try {
    return new URL(location, from);
  } catch {
    return undefined;
  }
}

/**
 * A fetch for requests that carry no secret. Every target, including each
 * redirect hop, must pass `checkTarget` against the endpoint the user named.
 * A GET follows redirects (also to another origin, as discovery documents are
 * sometimes hosted elsewhere); a request with a body follows only a 307/308
 * on its own origin.
 */
export function createOpenFetch(
  server: URL,
  limits: FetchLimits = {},
): FetchImpl {
  const fetchImpl = limits.fetchImpl ?? fetch;
  return async (input, init) => {
    let target = targetOf(input);
    const readOnly = (init?.method ?? "GET").toUpperCase() === "GET";
    for (let hop = 0; ; hop += 1) {
      checkTarget(target, server);
      const response = await limited(
        limits,
        target,
        (signal) =>
          fetchImpl(target, { ...init, redirect: "manual", signal }),
        init?.signal,
      );
      if (response.status < 300 || response.status >= 400) return response;
      const next = redirectTarget(response, target);
      await response.body?.cancel();
      const followable = readOnly
        ? [301, 302, 303, 307, 308].includes(response.status)
        : [307, 308].includes(response.status);
      if (
        !next ||
        !followable ||
        hop >= MAX_REDIRECTS ||
        (!readOnly && next.origin !== target.origin)
      ) {
        throw new McpInspectError(
          `${target.origin} answered with a redirect (HTTP ${response.status}) that was not followed.`,
        );
      }
      target = next;
    }
  };
}

/**
 * A fetch that sends only to `origins`. A redirect to the same origin is
 * followed up to three times (a 307/308 keeps method and body); any other
 * redirect is an error, and the response of the refused hop is not read.
 */
export function createCredentialedFetch(
  origins: readonly string[],
  limits: FetchLimits = {},
): FetchImpl {
  const fetchImpl = limits.fetchImpl ?? fetch;
  const allowed = new Set(origins);
  return async (input, init) => {
    let target = targetOf(input);
    for (let hop = 0; ; hop += 1) {
      if (!allowed.has(target.origin) || !isSecureOrigin(target)) {
        throw new McpInspectError(
          `Refusing to send credentials to ${target.origin}: they go only to ${[...allowed].join(" and ")}.`,
        );
      }
      const response = await limited(
        limits,
        target,
        (signal) =>
          fetchImpl(target, { ...init, redirect: "manual", signal }),
        init?.signal,
      );
      if (response.status < 300 || response.status >= 400) return response;
      const next = redirectTarget(response, target);
      await response.body?.cancel();
      if (
        !next ||
        hop >= MAX_REDIRECTS ||
        (response.status !== 307 && response.status !== 308)
      ) {
        throw new McpInspectError(
          `${target.origin} answered with a redirect (HTTP ${response.status}); a request that carries credentials is not redirected.`,
        );
      }
      if (next.origin !== target.origin) {
        throw new McpInspectError(
          `${target.origin} redirected to ${next.origin}; credentials are not sent across origins, so the request was stopped.`,
        );
      }
      target = next;
    }
  };
}
