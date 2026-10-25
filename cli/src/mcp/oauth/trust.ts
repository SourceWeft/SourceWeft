import { McpInspectError } from "../../errors";

/**
 * Where the sign-in may send requests. The authorization server's metadata is
 * written by the server the user named, so it is data to check, not to obey:
 * an endpoint that is on another origin than the issuer, on a private network,
 * or on plain http is refused before anything is sent to it or opened in the
 * browser.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function ipv4Octets(host: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function privateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Whether the host is the machine itself or a private, link-local or
 * unqualified name or address. A DNS name that merely resolves to a private
 * address cannot be told apart here.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain")
  ) {
    return true;
  }
  const v4 = ipv4Octets(host);
  if (v4) return privateIpv4(v4);
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16);
      const low = Number.parseInt(mapped[2]!, 16);
      return privateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    }
    return false;
  }
  // A name with no dot is a name on the local network.
  return !host.includes(".");
}

/**
 * Whether a request may go to `target`: https, or http on this machine when
 * the user's own endpoint is on this machine; a private host only when it is
 * the very host the user named.
 */
export function checkTarget(target: URL, server: URL): void {
  const serverIsLocal = isLoopbackHost(server.hostname);
  if (target.protocol === "http:") {
    if (serverIsLocal && isLoopbackHost(target.hostname)) return;
    throw new McpInspectError(
      `Refusing to contact ${target.origin}: sign-in uses https${
        isLoopbackHost(target.hostname)
          ? ", and a local address is accepted only when the endpoint you passed is local too"
          : ""
      }.`,
    );
  }
  if (target.protocol !== "https:") {
    throw new McpInspectError(
      `Refusing to contact ${target.origin}: sign-in uses https.`,
    );
  }
  if (isPrivateHost(target.hostname) && target.hostname !== server.hostname) {
    throw new McpInspectError(
      `Refusing to contact ${target.origin}: it is a private or local address that is not the host you passed with --url (${server.hostname}).`,
    );
  }
}

type AuthorizationServerMetadataLike = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string | undefined;
};

function withoutTrailingSlash(value: string): string {
  return new URL(value).href.replace(/\/+$/u, "");
}

/**
 * The authorization server as the sign-in will use it. The issuer must be the
 * address the server was discovered at (RFC 8414 §3.3), and every endpoint
 * must be on that issuer's origin: otherwise a server could pair a trusted
 * server's authorization page with its own token endpoint and receive the
 * authorization code and PKCE verifier.
 */
export function validateAuthorizationServer(
  metadata: AuthorizationServerMetadataLike,
  asUrl: string,
  server: URL,
): void {
  if (withoutTrailingSlash(metadata.issuer) !== withoutTrailingSlash(asUrl)) {
    throw new McpInspectError(
      `The authorization server was found at ${asUrl} but its metadata names the issuer ${metadata.issuer}; they must be the same, so sign-in was stopped.`,
    );
  }
  const issuer = new URL(asUrl);
  checkTarget(issuer, server);
  for (const [name, value] of [
    ["authorization endpoint", metadata.authorization_endpoint],
    ["token endpoint", metadata.token_endpoint],
    ["registration endpoint", metadata.registration_endpoint],
  ] as const) {
    if (value === undefined) continue;
    const endpoint = new URL(value);
    if (endpoint.origin !== issuer.origin) {
      throw new McpInspectError(
        `The authorization server ${issuer.origin} declares its ${name} on ${endpoint.origin}. Every endpoint must be on the issuer's own origin, so sign-in was stopped before anything was sent there.`,
      );
    }
  }
}
