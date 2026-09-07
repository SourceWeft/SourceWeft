import { BlockList, isIP } from "node:net";
import * as dns from "node:dns/promises";

type DnsLookupResult = {
  address: string;
  family: number;
};

type DnsLookup = (hostname: string) => Promise<DnsLookupResult[]>;

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

const BLOCKED_CUSTOM_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "cookie",
  "set-cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "connection",
  "content-length",
  "transfer-encoding",
]);

// BlockList compares addresses, including IPv4-mapped IPv6, rather than their
// spelling. Keep the existing IPv4 exclusions; 240/4 was covered by a >= 224.
const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicIpAddress(value: string) {
  const family = isIP(value);
  if (family === 4) {
    return !nonPublicAddresses.check(value, "ipv4");
  }
  if (family === 6) {
    return !nonPublicAddresses.check(value, "ipv6");
  }
  return false;
}

function isBlockedHostname(value: string) {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  return (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  );
}

async function defaultLookup(hostname: string) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

export async function assertPublicHostname(
  hostname: string,
  lookupHostname: DnsLookup = defaultLookup,
) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  if (!normalized || isBlockedHostname(normalized)) {
    throw new Error("Endpoint host is not allowed.");
  }

  if (isIP(normalized)) {
    if (!isPublicIpAddress(normalized)) {
      throw new Error("Endpoint host is not allowed.");
    }
    return;
  }

  const addresses = await lookupHostname(normalized);
  if (addresses.length === 0) {
    throw new Error("Endpoint host must resolve to a public address.");
  }

  for (const address of addresses) {
    if (!isPublicIpAddress(address.address)) {
      throw new Error("Endpoint host must resolve to public addresses only.");
    }
  }
}

export async function validatePublicHttpsEndpoint(
  input: string,
  lookupHostname?: DnsLookup,
) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Endpoint must be a valid HTTPS URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Endpoint must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Endpoint credentials are not allowed.");
  }

  await assertPublicHostname(url.hostname, lookupHostname);
  return url.toString().replace(/\/+$/, "");
}

export function sanitizeCustomHeaders(headers?: Record<string, string>) {
  if (!headers) {
    return {};
  }

  const sanitized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = rawValue.trim();
    if (!name || !value) {
      continue;
    }
    if (BLOCKED_CUSTOM_HEADER_NAMES.has(name.toLowerCase())) {
      throw new Error(`Custom header '${name}' is not allowed.`);
    }
    sanitized[name] = value;
  }

  return sanitized;
}
