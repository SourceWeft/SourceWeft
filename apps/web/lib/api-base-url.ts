import { publicRuntimeConfig } from "./public-runtime-config";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Development only. A loopback API origin is only reachable — and only same-site for
 * cookies — from a page served by that same host. A simulator, a phone on the LAN or a
 * `*.localhost` alias is served from a different host, which would leave the session
 * cookie cross-site and dropped. Keep the API port and follow the page's host.
 */
export function followPageHost(
  configured: string,
  pageHostname: string | undefined,
) {
  if (!pageHostname) {
    return configured;
  }

  try {
    const url = new URL(configured);
    if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
      return configured;
    }
    if (url.hostname === pageHostname) {
      return configured;
    }

    url.hostname = pageHostname;
    return url.origin;
  } catch {
    return configured;
  }
}

// All browser HTTP, authentication, SSE and websocket clients share this origin.
export const apiBaseUrl =
  followPageHost(
    publicRuntimeConfig().apiBaseUrl.replace(/\/$/, ""),
    typeof window === "undefined" ? undefined : window.location.hostname,
  ) ||
  (typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:3001");
