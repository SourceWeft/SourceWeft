import {
  DEFAULT_USER_SETTINGS,
  userSettingsSchema,
  type UpdateUserSettingsRequest,
  type UserSettings,
} from "@sourceweft/contracts";

import { parsePreviewFlags } from "../preview/features";

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
  // Preference sanitization must never reinterpret independently managed access.
  const preview = parsePreviewFlags(value);
  if (hasSecretLikeKey(value) || jsonSize(value) > MAX_JSON_BYTES) {
    return { appearance: DEFAULT_USER_SETTINGS.appearance, preview };
  }
  const appearance =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).appearance
      : undefined;
  const parsed = userSettingsSchema.shape.appearance.safeParse(appearance);
  const next = {
    appearance: parsed.success ? parsed.data : DEFAULT_USER_SETTINGS.appearance,
    preview,
  };
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
