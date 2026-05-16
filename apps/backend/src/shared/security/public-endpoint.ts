import { isIP } from "node:net";
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

function parseIpv4(value: string) {
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }

  return parts as [number, number, number, number];
}

function isPublicIpv4(value: string) {
  const parts = parseIpv4(value);
  if (!parts) {
    return false;
  }

  const [a, b, c, d] = parts;
  if (a === 0 || a === 10 || a === 127) {
    return false;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }
  if (a === 192 && b === 168) {
    return false;
  }
  if (a === 192 && b === 0 && c === 0) {
    return false;
  }
  if (a === 192 && b === 0 && c === 2) {
    return false;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return false;
  }
  if (a === 198 && b === 51 && c === 100) {
    return false;
  }
  if (a === 203 && b === 0 && c === 113) {
    return false;
  }
  if (a >= 224) {
    return false;
  }

  return !(a === 255 && b === 255 && c === 255 && d === 255);
}

function normalizeIpv6(value: string) {
  return value.toLowerCase();
}

function isPublicIpv6(value: string) {
  const normalized = normalizeIpv6(value);
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff")
  ) {
    return false;
  }

  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const mappedIpv4Address = mappedIpv4?.[1];
  if (mappedIpv4Address) {
    return isPublicIpv4(mappedIpv4Address);
  }

  return true;
}

export function isPublicIpAddress(value: string) {
  const family = isIP(value);
  if (family === 4) {
    return isPublicIpv4(value);
  }
  if (family === 6) {
    return isPublicIpv6(value);
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
