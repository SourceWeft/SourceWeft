import {
  DEFAULT_USER_SETTINGS,
  userSettingsSchema,
  type UpdateUserSettingsRequest,
  type UserSettings,
} from "@sourceweft/contracts";

export { DEFAULT_USER_SETTINGS };

const MAX_JSON_BYTES = 16 * 1024;

function jsonSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function hasSecretLikeKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasSecretLikeKey);
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) =>
      /secret|token|api[_-]?key|password|credential/i.test(key) ||
      hasSecretLikeKey(item),
  );
}

export function normalizeUserSettings(value: unknown): UserSettings {
  if (hasSecretLikeKey(value)) {
    return DEFAULT_USER_SETTINGS;
  }
  const parsed = userSettingsSchema.safeParse(value);
  const next = parsed.success ? parsed.data : DEFAULT_USER_SETTINGS;
  if (jsonSize(next) > MAX_JSON_BYTES) {
    return DEFAULT_USER_SETTINGS;
  }
  return next;
}

export function mergeUserSettings(
  current: UserSettings,
  patch: UpdateUserSettingsRequest,
) {
  return normalizeUserSettings({
    ...current,
    appearance: {
      ...current.appearance,
      ...patch.appearance,
    },
  });
}
