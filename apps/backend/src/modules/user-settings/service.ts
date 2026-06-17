import type { UpdateUserSettingsRequest } from "@sourceweft/contracts";
import { database } from "@sourceweft/db";
import { mergeUserSettings, normalizeUserSettings } from "./settings";

export class UserSettingsService {
  async getUserSettings(input: { userId: string }) {
    const result = await database.query<{ settings: unknown }>(
      `select settings from user_settings where user_id = $1 limit 1`,
      [input.userId],
    );

    return {
      settings: normalizeUserSettings(result.rows[0]?.settings),
    };
  }

  async updateUserSettings(input: {
    userId: string;
    patch: UpdateUserSettingsRequest;
  }) {
    const current = await this.getUserSettings({ userId: input.userId });
    const next = mergeUserSettings(current.settings, input.patch);

    const result = await database.query<{ settings: unknown }>(
      `
        insert into user_settings (user_id, settings)
        values ($1, $2::jsonb)
        on conflict (user_id) do update
        set settings = excluded.settings,
            updated_at = now()
        returning settings
      `,
      [input.userId, JSON.stringify(next)],
    );

    return {
      settings: normalizeUserSettings(result.rows[0]?.settings),
    };
  }
}

export const userSettingsService = new UserSettingsService();
