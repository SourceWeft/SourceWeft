import { createHash } from "node:crypto";
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

export function assertSafeMcpEndpoint(value: string, input: { allowLocalhost: boolean }) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError(400, "MCP_ENDPOINT_INVALID", "MCP endpoint URL is invalid");
  }

  if (url.protocol !== "https:" && !(input.allowLocalhost && url.protocol === "http:")) {
    throw new McpError(
      400,
      "MCP_ENDPOINT_UNSAFE",
      "MCP endpoint must use https. Local http is only allowed in development.",
    );
  }

  const hostname = url.hostname.toLowerCase();
  const localhostAllowed =
    input.allowLocalhost &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost"));
  if (localhostAllowed) {
    return url.toString();
  }

  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.startsWith("169.254.") ||
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
