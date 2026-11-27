import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";

/**
 * A fetch scope shaped like the host's credentialed one
 * (`createCredentialedFetchScope` over `createControlledFetch`, read on
 * 2026-11-27 and exercised once against the real thing, see the Task 6 report),
 * reduced to what the Ghost client can observe:
 *
 * - the scope calls the transport with `redirect: "manual"` and, when the
 *   caller also asked for `manual`, inspects a 301/302/303/307/308 answer that
 *   carries a `Location`;
 * - a target on another origin (or one the endpoint policy refuses: not https,
 *   not a public host) makes the scope THROW an `EndpointPolicyError` instead of
 *   returning the response, after recording the denial, so every later call on
 *   the same scope throws it too;
 * - a same-origin target returns the 3xx response unchanged;
 * - the error carries `name: "EndpointPolicyError"` and
 *   `code: "ENDPOINT_NOT_ALLOWED"` and a fixed message that does not contain the
 *   URL; it is the only identity the connector may rely on, because a connector
 *   package never imports backend code.
 *
 * It never follows a redirect, so a test can assert that no request reached
 * the redirect target.
 */
export class HostPolicyError extends Error {
  readonly code = "ENDPOINT_NOT_ALLOWED";
  constructor(readonly reason: "redirect" | "protocol" | "host") {
    super(
      reason === "redirect"
        ? "Cross-origin endpoint redirects are not allowed; configure the destination endpoint directly."
        : "Endpoint host is not allowed by deployment policy.",
    );
    this.name = "EndpointPolicyError";
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type HostLikeScope = ConnectorPublicFetchScope & {
  /** How many scopes this factory has opened and closed. */
  readonly state: { closed: boolean; denied: HostPolicyError | undefined };
};

export function hostLikeScope(transport: typeof fetch): HostLikeScope {
  const state: { closed: boolean; denied: HostPolicyError | undefined } = {
    closed: false,
    denied: undefined,
  };
  const scopeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (state.denied) throw state.denied;
    if (state.closed) throw new Error("Controlled request scope is closed");
    const url = new URL(String(input));
    const response = await transport(input, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (!location || !REDIRECTS.has(response.status)) return response;
    if (init?.redirect !== "manual") {
      throw new Error("this model only covers callers that ask for manual");
    }
    let target: URL;
    try {
      target = new URL(location, url);
    } catch {
      return response;
    }
    if (target.protocol !== "https:" || target.origin !== url.origin) {
      state.denied ??= new HostPolicyError(
        target.protocol !== "https:" ? "protocol" : "redirect",
      );
      await response.body?.cancel().catch(() => undefined);
      throw state.denied;
    }
    return response;
  }) as typeof fetch;
  return {
    fetch: scopeFetch,
    close: async () => {
      state.closed = true;
    },
    state,
  };
}
