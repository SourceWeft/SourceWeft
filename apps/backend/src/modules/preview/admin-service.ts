import { z } from "zod";
import {
  previewFeatureSchema,
  previewFlagsSchema,
} from "@sourceweft/contracts";
import { logger } from "../../shared/logger";
import { userSettingsRepository } from "../user-settings/repository";
import { parsePreviewFlags } from "./features";

const changeSchema = z
  .object({
    userId: z.string().trim().min(1),
    feature: previewFeatureSchema,
    actor: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(1000),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type PreviewChangeInput = z.input<typeof changeSchema>;

export class PreviewAdminService {
  constructor(private readonly repository = userSettingsRepository) {}

  private async requireUser(userId: string) {
    if (!(await this.repository.userExists(userId)))
      throw new Error("User not found");
  }

  async get(userId: string) {
    userId = z.string().trim().min(1).parse(userId);
    await this.requireUser(userId);
    return {
      userId,
      preview: parsePreviewFlags(
        await this.repository.findByUserId(userId),
        userId,
      ),
    };
  }

  grant(input: PreviewChangeInput) {
    return this.change(input, true);
  }
  revoke(input: PreviewChangeInput) {
    return this.change(input, false);
  }

  private async change(input: PreviewChangeInput, enabled: boolean) {
    const parsed = changeSchema.parse(input);
    const { userId, feature, actor, reason, dryRun } = parsed;
    try {
      await this.requireUser(userId);
      let before: boolean;
      let after: boolean;
      if (dryRun) {
        const stored = await this.repository.findByUserId(userId);
        const preview = (stored as { preview?: unknown } | undefined)?.preview;
        if (
          preview !== undefined &&
          !previewFlagsSchema.safeParse(preview).success
        ) {
          throw new Error(
            "Stored preview settings are malformed; repair them explicitly before changing access",
          );
        }
        before = parsePreviewFlags(stored, userId)[feature];
        after = enabled;
      } else {
        const change = await this.repository.setPreviewFeature(
          userId,
          feature,
          enabled,
        );
        before = parsePreviewFlags(change.before, userId)[feature];
        after = parsePreviewFlags(change.after, userId)[feature];
      }
      const result = {
        userId,
        feature,
        before,
        after,
        dryRun,
        changed: before !== after,
      };
      logger.info("User preview change", {
        event: "user.preview.change",
        actor,
        reason,
        ...result,
        outcome: dryRun ? "dry-run" : "success",
        timestamp: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      logger.error("User preview change failed", {
        event: "user.preview.change",
        actor,
        reason,
        userId,
        feature,
        dryRun,
        outcome: "failure",
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }
}

export const previewAdminService = new PreviewAdminService();
