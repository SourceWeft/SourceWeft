const SENSITIVE_KEY_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|password|api[_-]?key|secret|credential)/i;
const SIGNED_URL_PARAM_PATTERN =
  /(?:x-amz-|x-goog-|x-ms-|signature|token|credential|expires|policy|key-pair-id|response-content-disposition)/i;

export function redactConnectorSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactConnectorSecrets(item));
  }

  if (typeof value === "string") {
    return redactSignedUrl(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactConnectorSecrets(item);
  }
  return redacted;
}

function redactSignedUrl(value: string) {
  if (!/^https?:\/\//i.test(value) || !value.includes("?")) {
    return value;
  }
  try {
    const url = new URL(value);
    let changed = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (SIGNED_URL_PARAM_PATTERN.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

export function buildRequestPreview(input: {
  actionType: string;
  request: Record<string, unknown>;
}) {
  const target =
    typeof input.request.target === "string"
      ? input.request.target
      : typeof input.request.externalId === "string"
        ? input.request.externalId
        : null;
  return target
    ? `${input.actionType} on ${target}`
    : `${input.actionType} connector action`;
}
