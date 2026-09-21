import { toTaiwanTraditional } from "@sourceweft/i18n/hant";
import type { SkillOverviewJson } from "@sourceweft/db";

/**
 * zh-TW overviews are not written by the model: they are the zh-CN ones run
 * through the same Simplified → Taiwan Traditional conversion and glossary the
 * web app's zh-TW messages come from, so an overview uses the site's terms.
 */

export { toTaiwanTraditional };

/** A zh-CN overview as zh-TW. Category slugs are identifiers and stay as they are. */
export function convertOverviewToZhTw(
  overview: SkillOverviewJson,
): SkillOverviewJson {
  return {
    summary: toTaiwanTraditional(overview.summary),
    whatItDoes: toTaiwanTraditional(overview.whatItDoes),
    whenToUse: toTaiwanTraditional(overview.whenToUse),
    requirements: toTaiwanTraditional(overview.requirements),
    suggestedCategories: [...overview.suggestedCategories],
  };
}
