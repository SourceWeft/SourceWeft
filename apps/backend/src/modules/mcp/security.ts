import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { McpError } from "./errors";

const BLOCKED_HEADER_NAMES = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "proxy-authorization",
  "proxy-authenticate",
]);

const SENSITIVE_KEY_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|password|api[_-]?key|secret|credential|token)/i;

const BLOCKED_ENDPOINT_IPS = new BlockList();
BLOCKED_ENDPOINT_IPS.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_ENDPOINT_IPS.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_ENDPOINT_IPS.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_ENDPOINT_IPS.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_ENDPOINT_IPS.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_ENDPOINT_IPS.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_ENDPOINT_IPS.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_ENDPOINT_IPS.addSubnet("224.0.0.0", 4, "ipv4");
BLOCKED_ENDPOINT_IPS.addSubnet("240.0.0.0", 4, "ipv4");
BLOCKED_ENDPOINT_IPS.addAddress("::", "ipv6");
BLOCKED_ENDPOINT_IPS.addAddress("::1", "ipv6");
BLOCKED_ENDPOINT_IPS.addSubnet("fc00::", 7, "ipv6");
BLOCKED_ENDPOINT_IPS.addSubnet("fe80::", 10, "ipv6");
BLOCKED_ENDPOINT_IPS.addSubnet("ff00::", 8, "ipv6");

export function normalizeMcpSlug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export function normalizedMcpToolName(input: {
  serverSlug: string;
  toolName: string;
}) {
  const server = normalizeMcpSlug(input.serverSlug) || "server";
  const tool = normalizeMcpSlug(input.toolName) || "tool";
  return `mcp__${server}__${tool}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashJson(value: unknown) {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

export function redactMcpSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactMcpSecrets(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactMcpSecrets(item);
  }
  return output;
}

function hostnameWithoutIpv6Brackets(value: string) {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function isLocalhostName(hostname: string) {
  const normalized = hostnameWithoutIpv6Brackets(hostname.toLowerCase());
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function isBlockedIpHost(hostname: string) {
  const normalized = hostnameWithoutIpv6Brackets(hostname.toLowerCase());
  const ipVersion = isIP(normalized);
  if (!ipVersion) {
    return false;
  }
  return BLOCKED_ENDPOINT_IPS.check(
    normalized,
    ipVersion === 6 ? "ipv6" : "ipv4",
  );
}

export function assertSafeMcpEndpoint(value: string, input: { allowLocalhost: boolean }) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError(400, "MCP_ENDPOINT_INVALID", "MCP endpoint URL is invalid");
  }

  if (url.username || url.password) {
    throw new McpError(
      400,
      "MCP_ENDPOINT_UNSAFE",
      "MCP endpoint must not include credentials",
    );
  }

  const hostname = url.hostname.toLowerCase();
  const localhostAllowed = input.allowLocalhost && isLocalhostName(hostname);
  if (url.protocol === "http:") {
    if (localhostAllowed) {
      return url.toString();
    }
    throw new McpError(
      400,
      "MCP_ENDPOINT_UNSAFE",
      "MCP endpoint must use https. Local http is only allowed in development.",
    );
  }

  if (url.protocol !== "https:") {
    throw new McpError(
      400,
      "MCP_ENDPOINT_UNSAFE",
      "MCP endpoint must use https. Local http is only allowed in development.",
    );
  }

  if (localhostAllowed) {
    return url.toString();
  }

  if (
    isLocalhostName(hostname) ||
    isBlockedIpHost(hostname) ||
    hostname === "metadata.google.internal"
  ) {
    throw new McpError(
      400,
      "MCP_ENDPOINT_BLOCKED",
      "MCP endpoint points to a local, private, link-local, or metadata address",
    );
  }

  return url.toString();
}

export function sanitizeHeaderName(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalized)) {
    throw new McpError(400, "MCP_HEADER_INVALID", "MCP header name is invalid");
  }
  if (BLOCKED_HEADER_NAMES.has(normalized)) {
    throw new McpError(400, "MCP_HEADER_BLOCKED", "MCP header name is not allowed");
  }
  return value.trim();
}

export function sanitizeHeaders(headers: Record<string, string>) {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerName = sanitizeHeaderName(key);
    output[headerName] = value;
  }
  return output;
}
