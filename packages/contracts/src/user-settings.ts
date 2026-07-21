import { z } from "zod";

export const userThemeSchema = z.enum(["system", "light", "dark"]);
export const DEFAULT_USER_THEME = "system" as const;
export const DEFAULT_USER_SETTINGS = {
  appearance: { theme: DEFAULT_USER_THEME },
} as const;

export const userSettingsSchema = z
  .object({
    appearance: z
      .object({
        theme: userThemeSchema.default(DEFAULT_USER_THEME),
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
      })
      .strip()
      .optional(),
  })
  .strip()
  .refine((value) => value.appearance?.theme !== undefined, {
    message: "At least one user setting must be provided",
  });

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
