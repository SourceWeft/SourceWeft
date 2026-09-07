import * as dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { isPublicIpAddress } from "./public-endpoint";

export type EndpointLookup = (hostname: string) => Promise<LookupAddress[]>;
export type EndpointPolicy = {
  enforceAddressChecks: boolean;
  allowedInternalOrigins: readonly string[];
};

export class EndpointPolicyError extends Error {
  readonly code = "ENDPOINT_NOT_ALLOWED";
  constructor(
    readonly reason: "url" | "protocol" | "credentials" | "host" | "redirect",
    message: string,
  ) {
    super(message);
    this.name = "EndpointPolicyError";
  }
}

function endpointUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EndpointPolicyError(
      "url",
      "Endpoint must be a valid HTTP(S) URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EndpointPolicyError(
      "protocol",
      "Endpoint must use HTTP or HTTPS.",
    );
  }
  if (url.username || url.password) {
    throw new EndpointPolicyError(
      "credentials",
      "Endpoint must not include credentials.",
    );
  }
  if (url.hostname.includes("*"))
    throw new EndpointPolicyError(
      "host",
      "Endpoint wildcards are not allowed.",
    );
  url.hostname = url.hostname.replace(/\.$/, "");
  return url;
}

/** Operator-owned exact origins, never patterns or user-controlled URLs. */
export function parseAllowedInternalOrigins(
  name: string,
  raw: string | undefined,
): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  try {
    const entries: unknown = JSON.parse(raw);
    if (
      !Array.isArray(entries) ||
      entries.some((item) => typeof item !== "string")
    )
      throw new Error();
    return [
      ...new Set(
        entries.map((value: string) => {
          const url = endpointUrl(value);
          if (url.pathname !== "/" || url.search || url.hash) throw new Error();
          return url.origin;
        }),
      ),
    ];
  } catch {
    // Do not echo a malformed value: it could contain an accidentally pasted key.
    throw new Error(
      `${name} must be a JSON array of exact HTTP(S) origins without paths, credentials, query or fragments.`,
    );
  }
}

const internalServiceAddresses = new BlockList();
internalServiceAddresses.addSubnet("10.0.0.0", 8, "ipv4");
internalServiceAddresses.addSubnet("172.16.0.0", 12, "ipv4");
internalServiceAddresses.addSubnet("192.168.0.0", 16, "ipv4");
internalServiceAddresses.addSubnet("100.64.0.0", 10, "ipv4");
internalServiceAddresses.addSubnet("fc00::", 7, "ipv6");
const loopbacks = new BlockList();
loopbacks.addSubnet("127.0.0.0", 8, "ipv4");
loopbacks.addAddress("::1", "ipv6");

function inBlockList(list: BlockList, address: string) {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6");
}

function hostnameOf(url: URL) {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}
function explicitLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    inBlockList(loopbacks, hostname)
  );
}

export function checkEndpointUrl(value: string, policy: EndpointPolicy): URL {
  const url = endpointUrl(value);
  if (policy.enforceAddressChecks === false) return url;
  const internalAllowed = policy.allowedInternalOrigins.includes(url.origin);
  if (url.protocol !== "https:" && !internalAllowed) {
    throw new EndpointPolicyError(
      "protocol",
      "Endpoint must use HTTPS unless its origin is explicitly allowed by the deployment.",
    );
  }
  const host = hostnameOf(url);
  if (
    !internalAllowed &&
    (explicitLoopbackHost(host) ||
      host.endsWith(".localhost") ||
      host.endsWith(".local"))
  ) {
    throw new EndpointPolicyError(
      "host",
      "Endpoint host is not allowed by deployment policy.",
    );
  }
  if (isIP(host)) checkEndpointAddress(url, host, policy);
  return url;
}

function checkEndpointAddress(
  url: URL,
  address: string,
  policy: EndpointPolicy,
) {
  if (isPublicIpAddress(address)) return;
  if (policy.allowedInternalOrigins.includes(url.origin)) {
    if (inBlockList(internalServiceAddresses, address)) return;
    if (
      explicitLoopbackHost(hostnameOf(url)) &&
      inBlockList(loopbacks, address)
    )
      return;
  }
  throw new EndpointPolicyError(
    "host",
    "Endpoint resolved to an address not allowed by deployment policy.",
  );
}

/** Resolve once for the socket; strict mode validates every returned address. */
export async function resolveEndpointAddresses(
  url: URL,
  policy: EndpointPolicy,
  lookup: EndpointLookup = (hostname) =>
    dns.lookup(hostname, { all: true, verbatim: true }),
) {
  const hostname = hostnameOf(url);
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await lookup(hostname);
  if (addresses.length === 0)
    throw new EndpointPolicyError(
      "host",
      "Endpoint must resolve to an allowed address.",
    );
  if (policy.enforceAddressChecks !== false) {
    for (const address of addresses)
      checkEndpointAddress(url, address.address, policy);
  }
  return addresses;
}

export async function validateEndpointUrl(
  value: string,
  policy: EndpointPolicy,
  lookup?: EndpointLookup,
) {
  const url = checkEndpointUrl(value, policy);
  if (policy.enforceAddressChecks !== false)
    await resolveEndpointAddresses(url, policy, lookup);
  return url;
}
