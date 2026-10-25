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
