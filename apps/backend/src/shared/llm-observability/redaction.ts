import { toJsonSafe } from "./serializers";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "api-key",
  "api_key",
  "apikey",
  "api-key-encrypted",
  "api_key_encrypted",
  "apikeyencrypted",
  "access_token",
  "accesstoken",
  "refreshtoken",
  "refresh_token",
  "session-token",
  "session_token",
  "sessiontoken",
  "credential",
  "credentials",
  "x-api-key",
]);

export const REDACTED_VALUE = "[REDACTED]";

export function isSensitiveKey(key: string) {
  return SENSITIVE_KEYS.has(key.trim().toLowerCase());
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
