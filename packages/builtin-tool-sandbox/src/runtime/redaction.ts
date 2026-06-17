import { createHash } from "node:crypto";

const REDACTED_VALUE = "[redacted]";
const REQUEST_FINGERPRINT_FIELD = "_sourceweftRequestFingerprint";
const SENSITIVE_KEY_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|password|api[_-]?key|secret|credential|github[_-]?token|npm[_-]?token|private[_-]?key|^token$)/i;
const SIGNED_URL_PARAM_PATTERN =
  /(?:x-amz-|x-goog-|x-ms-|signature|token|credential|expires|policy|key-pair-id|response-content-disposition)/i;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function redactSignedUrl(value: string) {
  try {
    const url = new URL(value);
    let changed = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (SIGNED_URL_PARAM_PATTERN.test(key)) {
        url.searchParams.set(key, REDACTED_VALUE);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

export function sandboxRequestFingerprint(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function redactSandboxText(value: string) {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, (match) => redactSignedUrl(match))
    .replace(
      /(^|[\s;])([A-Z0-9_]*(?:ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION)[A-Z0-9_]*)(\s*=\s*)([^"'\s,;&]+)/giu,
      `$1$2$3${REDACTED_VALUE}`,
    )
    .replace(
      /(^|[\s;])(api[-_ ]?key|authorization|bearer|token|secret)(["'\s:=]+)([^"'\s,;&]+)/giu,
      `$1$2$3${REDACTED_VALUE}`,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu,
      REDACTED_VALUE,
    );
}

export function redactSandboxSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSandboxSecrets(item));
  }
  if (typeof value === "string") {
    return redactSandboxText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED_VALUE
      : redactSandboxSecrets(item);
  }
  return output;
}

export function redactSandboxOperationRequest(
  request: Record<string, unknown>,
) {
  const redacted = redactSandboxSecrets(request);
  const record =
    redacted && typeof redacted === "object" && !Array.isArray(redacted)
      ? (redacted as Record<string, unknown>)
      : {};
  return {
    ...record,
    [REQUEST_FINGERPRINT_FIELD]: sandboxRequestFingerprint(request),
  };
}
