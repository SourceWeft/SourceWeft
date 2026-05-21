const PROFILE_CONFIG_META_KEY = "_sourceweft";

type ProfileConfigMetadata = {
  protectedFields?: unknown;
};

export type ProtectedProfileConfigField =
  | "imageGeneration"
  | "supportedEfforts"
  | "supportedParameters"
  | "supportsImageInput";

function readProfileConfigMetadata(
  configJson: Record<string, unknown>,
): ProfileConfigMetadata {
  const metadata = configJson[PROFILE_CONFIG_META_KEY];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as ProfileConfigMetadata)
    : {};
}

export function readProtectedProfileConfigFields(
  configJson: Record<string, unknown>,
) {
  const metadata = readProfileConfigMetadata(configJson);
  if (!Array.isArray(metadata.protectedFields)) {
    return new Set<string>();
  }

  return new Set(
    metadata.protectedFields.filter(
      (field): field is string => typeof field === "string" && field.length > 0,
    ),
  );
}

export function withProtectedProfileConfigFields(
  configJson: Record<string, unknown>,
  protectedFields: Iterable<string>,
) {
  const metadata = readProfileConfigMetadata(configJson);
  return {
    ...configJson,
    [PROFILE_CONFIG_META_KEY]: {
      ...metadata,
      protectedFields: Array.from(new Set(protectedFields)).sort(),
    },
  };
}

export function stripFormerlyProtectedProfileConfigFields(
  configJson: Record<string, unknown>,
  nextProtectedFields: Iterable<string>,
) {
  const previousProtectedFields = readProtectedProfileConfigFields(configJson);
  if (previousProtectedFields.size === 0) {
    return withProtectedProfileConfigFields(configJson, nextProtectedFields);
  }

  const nextProtectedFieldSet = new Set(nextProtectedFields);
  const nextConfigJson = { ...configJson };
  for (const field of previousProtectedFields) {
    if (!nextProtectedFieldSet.has(field)) {
      delete nextConfigJson[field];
    }
  }
  return withProtectedProfileConfigFields(nextConfigJson, nextProtectedFieldSet);
}

export function pickProfileConfigOutsideOwnedFields(input: {
  configJson: Record<string, unknown>;
  ownedFields: ReadonlySet<string>;
}) {
  const protectedFields = readProtectedProfileConfigFields(input.configJson);
  return Object.fromEntries(
    Object.entries(input.configJson).filter(
      ([key]) => !input.ownedFields.has(key) || protectedFields.has(key),
    ),
  );
}

export function pickUnprotectedProfileConfigUpdates(input: {
  configJson: Record<string, unknown>;
  updates: Record<string, unknown>;
}) {
  const protectedFields = readProtectedProfileConfigFields(input.configJson);
  return Object.fromEntries(
    Object.entries(input.updates).filter(([key]) => !protectedFields.has(key)),
  );
}

export function mergeOwnedProfileConfig(input: {
  configJson: Record<string, unknown>;
  ownedFields: ReadonlySet<string>;
  updates: Record<string, unknown>;
}) {
  return {
    ...pickProfileConfigOutsideOwnedFields({
      configJson: input.configJson,
      ownedFields: input.ownedFields,
    }),
    ...pickUnprotectedProfileConfigUpdates({
      configJson: input.configJson,
      updates: input.updates,
    }),
  };
}
