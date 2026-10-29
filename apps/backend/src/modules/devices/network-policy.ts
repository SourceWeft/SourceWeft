import { BlockList, isIP } from "node:net";

/**
 * Host matching for the network allow list, written to agree with the
 * sandbox runtime's own matcher on the device so a rule the backend honours
 * is a rule the device would have honoured: an exact host, or `*.suffix` for
 * a strict subdomain of `suffix` (never the apex), case-insensitive, with an
 * optional `:port` suffix on the pattern. A wildcard never matches an IP.
 */

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST_CHARS = /^[a-z0-9._-]+$/;
const IPV6_CHARS = /^[0-9a-f:.]+$/;

function isIpLiteral(host: string) {
  return IPV4.test(host) || (host.includes(":") && IPV6_CHARS.test(host));
}

/**
 * Lower-cased host without brackets or a trailing root dot, or null when the
 * value cannot be a connectable host. This is the only form that is stored in
 * a trust rule or compared against patterns.
 */
export function canonicalNetworkHost(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  if (host.includes(":")) return IPV6_CHARS.test(host) ? host : null;
  if (!HOST_CHARS.test(host) || host.startsWith(".") || host.includes(".."))
    return null;
  return host;
}

function splitPatternPort(pattern: string): {
  host: string;
  port: number | undefined;
} {
  if (pattern.startsWith("[")) {
    const close = pattern.indexOf("]");
    if (close === -1) return { host: pattern, port: undefined };
    const rest = pattern.slice(close + 1);
    const port = /^:([1-9][0-9]{0,4})$/.exec(rest);
    return {
      host: pattern.slice(1, close),
      port: port && Number(port[1]) <= 65535 ? Number(port[1]) : undefined,
    };
  }
  const colon = pattern.lastIndexOf(":");
  // Two or more colons without brackets is an IPv6 literal, never host:port.
  if (colon === -1 || pattern.indexOf(":") !== colon)
    return { host: pattern, port: undefined };
  const port = /^[1-9][0-9]{0,4}$/.test(pattern.slice(colon + 1))
    ? Number(pattern.slice(colon + 1))
    : undefined;
  return port !== undefined && port <= 65535
    ? { host: pattern.slice(0, colon), port }
    : { host: pattern, port: undefined };
}

export function matchesNetworkPattern(
  host: string,
  port: number,
  pattern: string,
): boolean {
  const subject = canonicalNetworkHost(host);
  if (!subject) return false;
  const { host: patternHost, port: patternPort } = splitPatternPort(
    pattern.trim().toLowerCase(),
  );
  if (patternPort !== undefined && patternPort !== port) return false;
  // `*` alone is a deny-all marker in the runtime and must never allow here.
  if (patternHost === "*" || patternHost.length === 0) return false;
  if (patternHost.startsWith("*.")) {
    if (isIpLiteral(subject)) return false;
    const suffix = patternHost.slice(2);
    return suffix.length > 0 && subject.endsWith(`.${suffix}`);
  }
  return subject === (canonicalNetworkHost(patternHost) ?? patternHost);
}

export function matchesAnyNetworkPattern(
  host: string,
  port: number,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => matchesNetworkPattern(host, port, pattern));
}

/**
 * The form of an allow-list entry the device's sandbox runtime will accept, or
 * null when it would silently drop it. The runtime requires a dotted host (or a
 * `*.` wildcard with at least two labels behind it) or an IPv6 literal in
 * brackets; single-label names, bare `*` and unbracketed IPv6 are discarded,
 * which in strict mode would make a stored rule look honoured when it is not.
 */
export function sidecarAllowEntry(pattern: string): string | null {
  const value = pattern.trim().toLowerCase();
  if (value.startsWith("*.")) {
    const suffix = value.slice(2);
    const labels = suffix.split(".");
    return canonicalNetworkHost(suffix) === suffix &&
      labels.length >= 2 &&
      labels.every((label) => label.length > 0)
      ? value
      : null;
  }
  if (value.includes("*")) return null;
  const host = canonicalNetworkHost(value);
  if (!host) return null;
  if (host.includes(":")) return isIP(host) === 6 ? `[${host}]` : null;
  return host.includes(".") && !host.startsWith(".") ? host : null;
}

/**
 * Whether a host can ever be matched by a stored rule: a dotted host name.
 * Single-label names are not valid allow entries, and IP literals are the
 * device guard's business, not something a standing approval should cover.
 */
export function isAllowableRuleHost(host: string): boolean {
  const canonical = canonicalNetworkHost(host);
  if (!canonical || isIP(canonical) !== 0) return false;
  return sidecarAllowEntry(canonical) === canonical;
}

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");

/**
 * Whether a canonical host is a local, private, link-local, cloud-metadata or
 * otherwise non-public address (or `localhost`). The device refuses these in
 * every mode before it ever asks; this is the backend's own check on the same
 * rule, so no answer from here can ever allow one.
 */
export function isNonPublicNetworkHost(host: string): boolean {
  const canonical = canonicalNetworkHost(host);
  if (!canonical) return false;
  if (canonical === "localhost" || canonical.endsWith(".localhost"))
    return true;
  const family = isIP(canonical);
  if (family === 0) return false;
  // An IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(canonical);
  if (mapped) return NON_PUBLIC.check(mapped[1]!, "ipv4");
  return NON_PUBLIC.check(canonical, family === 4 ? "ipv4" : "ipv6");
}
