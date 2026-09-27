import type { UpdateUserSettingsRequest } from "@sourceweft/contracts";
import { userSettingsRepository } from "./repository";
import { normalizeUserSettings } from "./settings";

export class UserSettingsService {
  constructor(private readonly repository = userSettingsRepository) {}

  async getUserSettings(input: { userId: string }) {
    return {
      settings: normalizeUserSettings(
        await this.repository.findByUserId(input.userId),
      ),
    };
  }

  async updateUserSettings(input: {
    userId: string;
    patch: UpdateUserSettingsRequest;
  }) {
    return {
      settings: normalizeUserSettings(
        await this.repository.patchAppearance(input.userId, input.patch),
      ),
    };
  }
}

export const userSettingsService = new UserSettingsService();
