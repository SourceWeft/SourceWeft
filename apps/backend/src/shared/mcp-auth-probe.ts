/**
 * What an MCP endpoint says about authentication when sent one
 * unauthenticated `initialize`:
 * - "oauth": a 401 whose `WWW-Authenticate` names protected-resource metadata
 *   (RFC 9728) — the MCP authorization spec's OAuth discovery signal;
 * - "credential": a 401 without it — some credential is required, and the
 *   challenge alone does not say which;
 * - "open": anything else (an initialize answer, a redirect, an error page).
 */
export type McpEndpointAuthProbe = "open" | "credential" | "oauth";

const PROBE_TIMEOUT_MS = 5000;

/**
 * Send the probe through `fetchImpl`, which the caller scopes to its endpoint
 * policy (an SSRF-checked request scope). Redirects are not followed: the
 * endpoint passed the policy, but a 3xx could bounce the probe to an internal
 * address; a same-origin redirect is simply "not a 401". Network and policy
 * failures are thrown for the caller to handle.
 */
export async function probeMcpEndpointAuth(
  endpointUrl: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<McpEndpointAuthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpointUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "sourceweft-auth-probe", version: "1" },
        },
      }),
      signal: controller.signal,
    });
    await response.body?.cancel();
    if (response.status !== 401) {
      return "open";
    }
    const challenge = response.headers.get("www-authenticate") ?? "";
    return /\bresource_metadata\s*=/i.test(challenge) ? "oauth" : "credential";
  } finally {
    clearTimeout(timer);
  }
}
