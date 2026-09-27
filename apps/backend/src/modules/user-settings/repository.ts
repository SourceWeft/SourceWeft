import { database } from "@sourceweft/db";
import {
  previewFeatureSchema,
  previewFlagsSchema,
  updateUserSettingsRequestSchema,
  type PreviewFeature,
  type UpdateUserSettingsRequest,
} from "@sourceweft/contracts";
import { z } from "zod";

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

  async setPreviewFeature(
    userId: string,
    feature: PreviewFeature,
    enabled: boolean,
  ) {
    previewFeatureSchema.parse(feature);
    z.boolean().parse(enabled);
    const client = await database.connect();
    try {
      await client.query("begin");
      const user = await client.query(
        'select id from "user" where id = $1 for key share',
        [userId],
      );
      if (user.rowCount !== 1) throw new Error("User not found");
      await client.query(
        `insert into user_settings (user_id, settings) values ($1, '{}')
        on conflict (user_id) do nothing`,
        [userId],
      );
      const previous = await client.query<{ settings: unknown }>(
        "select settings from user_settings where user_id = $1 for update",
        [userId],
      );
      const previousSettings = previous.rows[0]!.settings as Record<
        string,
        unknown
      >;
      if (
        previousSettings.preview !== undefined &&
        !previewFlagsSchema.safeParse(previousSettings.preview).success
      ) {
        throw new Error(
          "Stored preview settings are malformed; repair them explicitly before changing access",
        );
      }
      const result = await client.query<{ settings: unknown }>(
        `
        update user_settings set settings = jsonb_set(settings, '{preview}',
          (case when jsonb_typeof(settings->'preview') = 'object'
            then settings->'preview' else '{}'::jsonb end) || $2::jsonb),
          updated_at = now()
        where user_id = $1 returning settings
      `,
        [userId, JSON.stringify({ [feature]: enabled })],
      );
      await client.query("commit");
      return {
        before: previous.rows[0]!.settings,
        after: result.rows[0]!.settings,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const userSettingsRepository = new UserSettingsRepository();
