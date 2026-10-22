/**
 * What an MCP endpoint says about authentication when sent one
 * unauthenticated `initialize`:
 * - "oauth": a 401 whose `WWW-Authenticate` names protected-resource metadata
 *   (RFC 9728) — the MCP authorization spec's OAuth discovery signal — or,
 *   when it names none, whose well-known protected-resource metadata lists an
 *   authorization server;
 * - "credential": a 401 without either — some credential is required, and the
 *   endpoint does not say which;
 * - "open": anything else (an initialize answer, a redirect, an error page).
 */
export type McpEndpointAuthProbe = "open" | "credential" | "oauth";

const PROBE_TIMEOUT_MS = 5000;
// Protected-resource metadata is a few hundred bytes; the endpoint is
// third-party, so a larger body is not read.
const METADATA_MAX_BYTES = 64 * 1024;

/** The body as text, or a throw once it passes `METADATA_MAX_BYTES`. */
async function readCappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > METADATA_MAX_BYTES) {
      await reader.cancel();
      throw new Error("Protected-resource metadata is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Send the probe through `fetchImpl`, which the caller scopes to its endpoint
 * policy (an SSRF-checked request scope). Redirects are not followed: the
 * endpoint passed the policy, but a 3xx could bounce the probe to an internal
 * address; a same-origin redirect is simply "not a 401". Network and policy
 * failures of the `initialize` are thrown for the caller to handle; those of
 * the well-known lookup only mean no metadata was found. One time budget
 * covers both.
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
    if (/\bresource_metadata\s*=/i.test(challenge)) {
      return "oauth";
    }
    return (await namesAuthorizationServer(
      endpointUrl,
      fetchImpl,
      controller.signal,
    ))
      ? "oauth"
      : "credential";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The RFC 9728 well-known metadata locations for an endpoint: the
 * path-specific one first, then the origin's. Query and fragment are not
 * part of a resource's metadata location.
 */
function protectedResourceMetadataUrls(endpointUrl: string): string[] {
  const url = new URL(endpointUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/**
 * Whether the endpoint's well-known protected-resource metadata names an
 * authorization server — OAuth discovery for a server whose 401 challenge
 * does not point at its metadata.
 */
async function namesAuthorizationServer(
  endpointUrl: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<boolean> {
  for (const metadataUrl of protectedResourceMetadataUrls(endpointUrl)) {
    try {
      const response = await fetchImpl(metadataUrl, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        continue;
      }
      const metadata = JSON.parse(await readCappedText(response)) as {
        authorization_servers?: unknown;
      } | null;
      const servers = metadata?.authorization_servers;
      if (Array.isArray(servers) && servers.length > 0) {
        return true;
      }
    } catch {
      // Unreachable, timed out or not JSON: no metadata at this location.
      if (signal.aborted) return false;
    }
  }
  return false;
}
