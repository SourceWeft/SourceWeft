const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

/**
 * Returns 4 for IPv4, 6 for IPv6, or 0 for non-IP strings.
 * Inline replacement for Node's `isIP` so the module stays client-compatible.
 */
function isIP(hostname: string): 0 | 4 | 6 {
  if (isIPv4(hostname)) return 4;
  if (isIPv6(hostname)) return 6;
  return 0;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(hostname: string): boolean {
  const match = hostname.match(IPV4_RE);
  if (!match) return false;
  return match.slice(1).every((octet) => {
    const n = Number.parseInt(octet, 10);
    return n >= 0 && n <= 255 && String(n) === octet;
  });
}

const IPV6_RE =
  /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^::([0-9a-fA-F]{0,4}:){0,6}[0-9a-fA-F]{0,4}$|^[0-9a-fA-F]{0,4}::([0-9a-fA-F]{0,4}:){0,5}[0-9a-fA-F]{0,4}$|^([0-9a-fA-F]{0,4}:){1,7}:$/;

function isIPv6(hostname: string): boolean {
  return IPV6_RE.test(hostname);
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    return true;
  }
  if (normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  if (isIP(normalized) === 4) {
    return isPrivateIpv4(normalized);
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd")
    );
  }
  return false;
}

export function validatePublicHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL must be a valid http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed.");
  }
  if (!url.hostname || isBlockedHostname(url.hostname)) {
    throw new Error("URL host is not allowed.");
  }
  return url.toString();
}
