import { McpInspectError } from "../../errors";

/**
 * Binds credentials to where they belong. A request that carries a token (the
 * access token to the endpoint, the code or refresh token to the token
 * endpoint) goes through `credentialedFetch`, which sends only to an origin it
 * was created for and never follows a redirect off it. Requests that carry
 * nothing secret (discovery, registration) use `openFetch`, which follows
 * redirects like any client but only to https (http for loopback).
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_SAME_ORIGIN_REDIRECTS = 3;

/** https, or http on the machine itself (development servers, tests). */
export function isSecureOrigin(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}

type FetchImpl = typeof fetch;

function targetOf(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

/** A fetch for requests that carry no secret: https only. */
export function createOpenFetch(fetchImpl: FetchImpl = fetch): FetchImpl {
  return async (input, init) => {
    const target = targetOf(input);
    if (!isSecureOrigin(target)) {
      throw new McpInspectError(
        `Refusing to contact ${target.origin}: authorization servers must use https.`,
      );
    }
    return fetchImpl(input, init);
  };
}

/**
 * A fetch that sends only to `origins`. A redirect to the same origin is
 * followed up to three times (a 307/308 keeps method and body); any other
 * redirect is an error, and the response of the refused hop is not read.
 */
export function createCredentialedFetch(
  origins: readonly string[],
  fetchImpl: FetchImpl = fetch,
): FetchImpl {
  const allowed = new Set(origins);
  return async (input, init) => {
    let target = targetOf(input);
    for (let hop = 0; ; hop += 1) {
      if (!allowed.has(target.origin) || !isSecureOrigin(target)) {
        throw new McpInspectError(
          `Refusing to send credentials to ${target.origin}: they go only to ${[...allowed].join(" and ")}.`,
        );
      }
      const response = await fetchImpl(target, {
        ...init,
        redirect: "manual",
      });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (
        !location ||
        hop >= MAX_SAME_ORIGIN_REDIRECTS ||
        (response.status !== 307 && response.status !== 308)
      ) {
        throw new McpInspectError(
          `${target.origin} answered with a redirect (HTTP ${response.status}); a request that carries credentials is not redirected.`,
        );
      }
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new McpInspectError("The server sent an invalid redirect.");
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
