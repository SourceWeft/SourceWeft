const SENSITIVE_KEY_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|password|api[_-]?key|secret|credential)/i;

export function redactConnectorSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactConnectorSecrets(item));
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
