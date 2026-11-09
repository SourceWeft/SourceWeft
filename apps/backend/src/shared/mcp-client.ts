import { Client } from "@modelcontextprotocol/client";

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

/**
 * Options every HTTP and SSE transport gets. The SDK 2 default follows a
 * redirect only within the request's origin; the backend's controlled fetch
 * already checks the address of every hop, so redirects are left to it, as
 * they were with SDK 1.
 */
export const MCP_TRANSPORT_DEFAULTS = { redirectPolicy: "follow" } as const;
