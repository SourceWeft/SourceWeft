import { createHash } from "node:crypto";
import { assertPublicHostname } from "../../shared/security/public-endpoint";
import { McpError } from "./errors";

type DnsLookupResult = { address: string; family: number };
type DnsLookup = (hostname: string) => Promise<DnsLookupResult[]>;

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

export async function assertSafeMcpEndpoint(
  value: string,
  input: {
    allowLocalhost: boolean;
    /**
     * Skip the resolved-address (SSRF) check. Development-only: dev machines
     * commonly sit behind fake-IP VPN/proxy DNS (Clash/Surge resolve every host
     * into 198.18.0.0/15), which would otherwise block every remote endpoint.
     * Production always keeps the check.
     */
    allowPrivateNetwork?: boolean;
    lookup?: DnsLookup;
  },
) {
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

  if (url.protocol !== "https:") {
    if (url.protocol === "http:" && localhostAllowed) {
      return url.toString();
    }
    throw new McpError(
      400,
      "MCP_ENDPOINT_UNSAFE",
      "MCP endpoint must use https. Local http is only allowed in development.",
    );
  }

  if (localhostAllowed) {
    return url.toString();
  }

  // Resolve DNS and reject any endpoint that maps to a private, link-local,
  // loopback, or cloud-metadata address. This closes the DNS-rebinding hole the
  // previous literal-IP-only check left open. Reuses the shared SSRF guard.
  if (input.allowPrivateNetwork) {
    return url.toString();
  }
  try {
    await assertPublicHostname(hostname, input.lookup);
  } catch {
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

const ENV_REF_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Resolve an env-sourced credential value. A stored value of exactly
 * `env:VAR_NAME` is replaced with `process.env.VAR_NAME` at use time, so
 * first-party / self-hosted MCP tokens can live in the environment (or a secret
 * manager) instead of the database — the SurfSense-style pattern. Any other
 * value is returned unchanged; a referenced-but-unset variable resolves to ""
 * so the header is simply omitted (and the connection fails as unauthenticated
 * rather than sending a literal "env:..." token).
 */
export function resolveCredentialEnvRef(value: string): string {
  const match = ENV_REF_PATTERN.exec(value.trim());
  const varName = match?.[1];
  if (!varName) {
    return value;
  }
  return process.env[varName] ?? "";
}
