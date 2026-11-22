import { database } from "@sourceweft/db";
import {
  updateUserSettingsRequestSchema,
  type UpdateUserSettingsRequest,
} from "@sourceweft/contracts";

export class UserSettingsRepository {
  async userExists(userId: string) {
    const result = await database.query('select id from "user" where id = $1', [
      userId,
    ]);
    return result.rowCount === 1;
  }

  async findByUserId(userId: string): Promise<unknown> {
    const result = await database.query<{ settings: unknown }>(
      "select settings from user_settings where user_id = $1",
      [userId],
    );
    return result.rows[0]?.settings;
  }

  async patchAppearance(
    userId: string,
    patch: UpdateUserSettingsRequest,
  ): Promise<unknown> {
    const parsed = updateUserSettingsRequestSchema.parse(patch);
    // Conflict handling locks the current row, including concurrent first writes.
    const result = await database.query<{ settings: unknown }>(
      `
      insert into user_settings (user_id, settings)
      values ($1, jsonb_build_object('appearance', $2::jsonb))
      on conflict (user_id) do update set
        settings = jsonb_set(user_settings.settings, '{appearance}',
          (case when jsonb_typeof(user_settings.settings->'appearance') = 'object'
            then user_settings.settings->'appearance' else '{}'::jsonb end) || $2::jsonb),
        updated_at = now()
      returning settings
    `,
      [userId, JSON.stringify(parsed.appearance)],
    );
    return result.rows[0]!.settings;
  }
}

export const userSettingsRepository = new UserSettingsRepository();
