import { toJsonSafe } from "./serializers";

const SENSITIVE_KEY_PATTERNS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "session",
  "credential",
  "credentials",
  "byok",
];

const SAFE_TOKEN_COUNTER_KEYS = new Set([
  "cachedtokenstotal",
  "cachereadtokens",
  "cachewritetokens",
  "inputtokens",
  "outputtokens",
  "totaltokens",
]);

export const REDACTED_VALUE = "[REDACTED]";

function normalizeKey(key: string) {
  return key.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
}

export function isSensitiveKey(key: string) {
  const normalized = normalizeKey(key);
  if (SAFE_TOKEN_COUNTER_KEYS.has(normalized.replace(/_/g, ""))) {
    return false;
  }
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function redactInternal(value: unknown, parentKey?: string): unknown {
  if (parentKey && isSensitiveKey(parentKey)) {
    return REDACTED_VALUE;
  }

  const safe = toJsonSafe(value);
  if (!safe || typeof safe !== "object") {
    return safe;
  }

  if (Array.isArray(safe)) {
    return safe.map((item) => redactInternal(item));
  }

  return Object.fromEntries(
    Object.entries(safe as Record<string, unknown>).map(([key, item]) => [
      key,
      redactInternal(item, key),
    ]),
  );
}

export function redactValue(value: unknown): unknown {
  return redactInternal(value);
}

export function redactRecord(value: unknown): Record<string, unknown> | null {
  const redacted = redactValue(value);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : null;
}

export function redactHeaders(
  headers: Record<string, unknown> | undefined | null,
): Record<string, unknown> | null {
  if (!headers) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isSensitiveKey(key) ? REDACTED_VALUE : toJsonSafe(value),
    ]),
  );
}
