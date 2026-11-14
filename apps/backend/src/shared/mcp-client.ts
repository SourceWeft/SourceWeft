import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  type RequestOptions,
  type Transport,
} from "@modelcontextprotocol/client";

/**
 * An MCP client that speaks both protocol eras. `connect()` first probes the
 * server with `server/discover`: a server that answers it is used on the
 * modern revision (2026-07-28 and later); anything else falls back to the
 * legacy `initialize` handshake (2024-11-05 … 2025-11-25). Without this an
 * SDK 2 client speaks only the legacy era, and servers that support only the
 * modern one are unreachable.
 */
export function createMcpClient(name: string) {
  return new Client(
    { name, version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
}

/** The probe's 401 or 403, which `auto` negotiation treats as final. */
function isAuthorizationRefusal(error: unknown) {
  return (
    SdkError.isInstance(error) &&
    (error.code === SdkErrorCode.ClientHttpAuthentication ||
      error.code === SdkErrorCode.ClientHttpForbidden)
  );
}

/** A 401 or 403 from the legacy handshake, which reports it less precisely. */
function isRefusedStatus(error: unknown) {
  return (
    SdkHttpError.isInstance(error) &&
    (error.data?.status === 401 || error.data?.status === 403)
  );
}

/**
 * A client from `createMcpClient`, connected over a transport from
 * `openTransport`. Some legacy servers refuse every method they do not know,
 * `server/discover` included, with 401 or 403 while `initialize` stays open;
 * `auto` negotiation does not fall back on a refused probe. So a 401/403 is
 * followed by one legacy `initialize` connection on a fresh client and
 * transport. A server that refuses that too fails with the probe's error, as
 * it did before the fallback. `onClient` sees each client before it
 * connects, so the caller can close it while the connection is in flight.
 */
export async function connectMcpClient(
  name: string,
  openTransport: () => Transport,
  options?: RequestOptions,
  onClient?: (client: Client) => void,
): Promise<Client> {
  const negotiated = createMcpClient(name);
  onClient?.(negotiated);
  let refusal: unknown;
  try {
    await negotiated.connect(openTransport(), options);
    return negotiated;
  } catch (error) {
    await negotiated.close().catch(() => {});
    if (!isAuthorizationRefusal(error)) throw error;
    refusal = error;
  }
  const legacy = createMcpClient(name);
  onClient?.(legacy);
  try {
    await legacy.connect(openTransport(), {
      ...options,
      prior: { kind: "legacy" },
    });
    return legacy;
  } catch (error) {
    await legacy.close().catch(() => {});
    throw isRefusedStatus(error) ? refusal : error;
  }
}

/**
 * Options every HTTP and SSE transport gets. The SDK 2 default follows a
 * redirect only within the request's origin; the backend's controlled fetch
 * already checks the address of every hop, so redirects are left to it, as
 * they were with SDK 1.
 */
export const MCP_TRANSPORT_DEFAULTS = { redirectPolicy: "follow" } as const;
