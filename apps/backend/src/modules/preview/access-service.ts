import {
  previewFeatureSchema,
  type PreviewFeature,
} from "@sourceweft/contracts";
import { userSettingsRepository } from "../user-settings/repository";
import { parsePreviewFlags } from "./features";
import { PreviewAccessError } from "./errors";

export class PreviewAccessService {
  constructor(private readonly repository = userSettingsRepository) {}

  async getFlags(userId: string) {
    return parsePreviewFlags(
      await this.repository.findByUserId(userId),
      userId,
    );
  }

  async isEnabled(userId: string, feature: PreviewFeature): Promise<boolean> {
    previewFeatureSchema.parse(feature);
    return (await this.getFlags(userId))[feature];
  }

  async requireEnabled(userId: string, feature: PreviewFeature): Promise<void> {
    if (!(await this.isEnabled(userId, feature)))
      throw new PreviewAccessError();
  }
}

export const previewAccessService = new PreviewAccessService();
