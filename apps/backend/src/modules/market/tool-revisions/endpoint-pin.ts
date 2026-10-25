import { createHash } from "node:crypto";

/**
 * The identity of a listing's endpoint, for the two sources that read a
 * server's tools with someone's credentials (Issue #367): a platform snapshot
 * and a member's authenticated discovery. A list may only be attached to the
 * listing whose CURRENT `manifest.endpointUrl` it was read from, so tools (and
 * the credentials used to read them) are never tied to a different server.
 *
 * Pure string work, no network: nothing here resolves a name or follows a
 * redirect. A redirect on the vendor's side is the vendor's own server; a
 * redirect the reading tool followed to ANOTHER origin is the tool's to refuse
 * (it submits the URL it was pinned to, and this compares that).
 */

export type EndpointPin = {
  /** The host alone, normalised: no port, no trailing dot. */
  hostname: string;
  /** `scheme://host[:port]`, normalised. */
  origin: string;
  /** Origin, path and query, normalised: what two endpoints must share. */
  key: string;
};

/**
 * The pin of an absolute http(s) URL, or null when it cannot be pinned:
 * not a URL, another scheme, or it carries userinfo (a secret in the URL is
 * never a listing's address). Normalisation is the WHATWG URL parser's
 * (lower-cased host, punycode, default port dropped, dot segments resolved)
 * plus one thing it leaves alone: trailing dots on the host
 * (`example.com.` is `example.com`). The fragment is dropped (never sent).
 * Everything else is compared exactly: a different port, path, query or
 * percent-encoding is a different endpoint.
 */
export function pinEndpoint(raw: string): EndpointPin | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const hostname = url.hostname.replace(/\.+$/, "");
  if (hostname === "") return null;
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  const origin = `${url.protocol}//${host}`;
  return { hostname, origin, key: `${origin}${url.pathname}${url.search}` };
}

/**
 * The pin of a bare origin (`https://mcp.example.com`, optionally with a root
 * slash): null when it has a path, query, fragment or userinfo.
 */
export function pinOrigin(raw: string): string | null {
  const pin = pinEndpoint(raw);
  if (!pin) return null;
  const url = new URL(raw);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return pin.origin;
}

/** Same pinned endpoint: either side that cannot be pinned never matches. */
export function sameEndpoint(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pinnedA = pinEndpoint(a);
  const pinnedB = pinEndpoint(b);
  return pinnedA !== null && pinnedB !== null && pinnedA.key === pinnedB.key;
}

/** What is stored in place of the endpoint itself. */
export function endpointKeyHash(pin: EndpointPin): string {
  return createHash("sha256").update(pin.key).digest("hex");
}
