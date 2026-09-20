import { z } from "zod";

export const userThemeSchema = z.enum(["system", "light", "dark"]);
export const DEFAULT_USER_THEME = "system" as const;

/**
 * Preferred UI language. `"system"` follows the browser's `Accept-Language`
 * (the same "follow the environment" semantics as `theme: "system"`); the other
 * values are the supported locales. The non-"system" values must stay aligned
 * with `LOCALE_IDS` in `@sourceweft/i18n`; a cross-package test in apps/web
 * asserts they match. Stored in the `user_settings` jsonb, so adding a language
 * needs no DB migration (design §11).
 */
export const userLanguageSchema = z.enum(["system", "en", "zh-CN", "zh-TW"]);
export const DEFAULT_USER_LANGUAGE = "system" as const;

export const DEFAULT_USER_SETTINGS = {
  appearance: { theme: DEFAULT_USER_THEME, language: DEFAULT_USER_LANGUAGE },
} as const;

export const userSettingsSchema = z
  .object({
    appearance: z
      .object({
        theme: userThemeSchema.default(DEFAULT_USER_THEME),
        language: userLanguageSchema.default(DEFAULT_USER_LANGUAGE),
      })
      .strip()
      .default(DEFAULT_USER_SETTINGS.appearance),
  })
  .strip();

export const getUserSettingsResponseSchema = z.object({
  settings: userSettingsSchema,
});

export const updateUserSettingsRequestSchema = z
  .object({
    appearance: z
      .object({
        theme: userThemeSchema.optional(),
        language: userLanguageSchema.optional(),
      })
      .strip()
      .optional(),
  })
  .strip()
  .refine(
    (value) =>
      value.appearance?.theme !== undefined ||
      value.appearance?.language !== undefined,
    {
      message: "At least one user setting must be provided",
    },
  );

export const updateUserSettingsResponseSchema = getUserSettingsResponseSchema;

export type UserSettings = z.infer<typeof userSettingsSchema>;
export type GetUserSettingsResponse = z.infer<
  typeof getUserSettingsResponseSchema
>;
export type UpdateUserSettingsRequest = z.infer<
  typeof updateUserSettingsRequestSchema
>;
export type UpdateUserSettingsResponse = z.infer<
  typeof updateUserSettingsResponseSchema
>;
