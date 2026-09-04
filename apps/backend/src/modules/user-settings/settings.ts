import {
  DEFAULT_USER_SETTINGS,
  userSettingsSchema,
  type UpdateUserSettingsRequest,
  type UserSettings,
} from "@sourceweft/contracts";

export { DEFAULT_USER_SETTINGS };

const MAX_JSON_BYTES = 16 * 1024;

/**
 * Byte size of `value` serialized as JSON, or 0 when it has no serialization.
 *
 * `JSON.stringify` returns the VALUE `undefined` — not a string — for
 * `undefined`, a function or a symbol, and `Buffer.byteLength(undefined)`
 * throws. That is the ordinary read path, not an exotic one: a user with no
 * `user_settings` row yet reaches `normalizeUserSettings(undefined)`, so every
 * settings fetch 500'd until the user had saved settings at least once.
 *
 * 0 is the honest answer for something with no JSON at all, and it lets such a
 * value fall through to the schema parse below, which is already the thing that
 * decides unusable input becomes the defaults.
 */
function jsonSize(value: unknown) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
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
  if (jsonSize(value) > MAX_JSON_BYTES) {
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
