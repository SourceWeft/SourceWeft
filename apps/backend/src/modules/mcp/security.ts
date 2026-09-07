import { createHash } from "node:crypto";
import {
  EndpointPolicyError,
  validateEndpointUrl,
} from "../../shared/security/endpoint-policy";
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
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Value-level secret patterns for free-text redaction. `redactMcpSecrets` works
 * key-by-key on structured data, but MCP error strings are opaque text a hostile
 * or buggy server controls (and an auth failure may echo the presented header),
 * so before an MCP error is persisted or streamed to co-participants its likely
 * secret-bearing substrings are masked. Best-effort, deliberately broad.
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:access|refresh|api)[_-]?tokens?["'=:\s]+[A-Za-z0-9._~+/-]{8,}/gi,
  /\b(?:client[_-]?secret|password|api[_-]?key|secret|credential)["'=:\s]+\S{6,}/gi,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9._-]{10,}/g,
];

/** Mask likely secret substrings in a free-text (error) message. */
export function redactErrorMessage(message: string): string {
  if (!message) {
    return message;
  }
  let output = message;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
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

export async function assertSafeMcpEndpoint(
  value: string,
  input: {
    enforceAddressChecks: boolean;
    allowedInternalOrigins?: readonly string[];
    lookup?: DnsLookup;
  },
) {
  try {
    const url = await validateEndpointUrl(
      value,
      {
        enforceAddressChecks: input.enforceAddressChecks,
        allowedInternalOrigins: input.allowedInternalOrigins ?? [],
      },
      input.lookup,
    );
    return url.toString();
  } catch (error) {
    const reason = error instanceof EndpointPolicyError ? error.reason : "host";
    throw new McpError(
      400,
      reason === "url"
        ? "MCP_ENDPOINT_INVALID"
        : reason === "host"
          ? "MCP_ENDPOINT_BLOCKED"
          : "MCP_ENDPOINT_UNSAFE",
      error instanceof EndpointPolicyError
        ? error.message
        : "MCP endpoint could not resolve to an allowed address",
    );
  }
}

export function sanitizeHeaderName(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalized)) {
    throw new McpError(400, "MCP_HEADER_INVALID", "MCP header name is invalid");
  }
  if (BLOCKED_HEADER_NAMES.has(normalized)) {
    throw new McpError(
      400,
      "MCP_HEADER_BLOCKED",
      "MCP header name is not allowed",
    );
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
 * Only environment variables under this namespace may be referenced from MCP
 * credentials. Without the restriction, any workspace admin could point an
 * install at their own endpoint and reference e.g.
 * `env:MODEL_GATEWAY_ENCRYPTION_SECRET` — exfiltrating infrastructure secrets
 * (the encryption root, DB URLs, cloud keys) to an attacker-controlled server.
 * Operators opt secrets into MCP use by naming them MCP_CRED_*.
 */
const ALLOWED_ENV_REF_PREFIX = "MCP_CRED_";

/**
 * Resolve an env-sourced credential value. A stored value of exactly
 * `env:MCP_CRED_*` is replaced with the matching `process.env` value at use
 * time, so first-party / self-hosted MCP tokens can live in the environment (or
 * a secret manager) instead of the database — the SurfSense-style pattern. A
 * reference outside the MCP_CRED_ namespace or to an unset variable resolves to
 * "" so the header is omitted (the connection fails as unauthenticated rather
 * than leaking either the literal "env:..." string or a forbidden secret). Any
 * non-reference value is returned unchanged.
 */
export function resolveCredentialEnvRef(value: string): string {
  const match = ENV_REF_PATTERN.exec(value.trim());
  const varName = match?.[1];
  if (!varName) {
    return value;
  }
  if (!varName.startsWith(ALLOWED_ENV_REF_PREFIX)) {
    return "";
  }
  return process.env[varName] ?? "";
}
