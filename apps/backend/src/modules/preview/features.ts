import { previewFlagsSchema, type PreviewFlags } from "@sourceweft/contracts";
import { logger } from "../../shared/logger";

export const PREVIEW_FEATURES = ["gmail"] as const;

/** Missing state denies. Malformed state denies with value-free diagnostics. */
export function parsePreviewFlags(
  settings: unknown,
  userId?: string,
): PreviewFlags {
  if (settings === undefined || settings === null) return { gmail: false };
  if (typeof settings !== "object" || Array.isArray(settings)) {
    logger.warn("Invalid stored preview settings", {
      userId,
      code: "PREVIEW_SETTINGS_INVALID",
    });
    return { gmail: false };
  }
  const preview = (settings as Record<string, unknown>).preview;
  if (preview === undefined) return { gmail: false };
  const parsed = previewFlagsSchema.safeParse(preview);
  if (!parsed.success) {
    logger.warn("Invalid stored preview settings", {
      userId,
      code: "PREVIEW_SETTINGS_INVALID",
    });
    return { gmail: false };
  }
  return parsed.data;
}
