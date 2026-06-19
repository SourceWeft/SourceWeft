export type PublishArtifactToolSelection = {
  enabled?: boolean;
};

export type GenerateVideoPresentationToolSelection = {
  enabled?: boolean;
  narration?: {
    enabled?: boolean;
  };
};

function normalizeOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeGenerateVideoPresentationToolSelection(
  input: unknown,
): GenerateVideoPresentationToolSelection | undefined {
  const record = normalizeRecord(input);
  if (!record) {
    return undefined;
  }

  const enabled = normalizeOptionalBoolean(record.enabled);
  const narrationRecord = normalizeRecord(record.narration);
  const narrationEnabled = normalizeOptionalBoolean(narrationRecord?.enabled);
  const narration =
    narrationEnabled !== undefined ? { enabled: narrationEnabled } : undefined;

  if (enabled === undefined && !narration) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(narration ? { narration } : {}),
  };
}
