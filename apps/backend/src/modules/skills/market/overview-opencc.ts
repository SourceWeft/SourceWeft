import { Converter } from "opencc-js/cn2t";
import type { SkillOverviewJson } from "@sourceweft/db";

/**
 * zh-TW overviews are not written by the model: they are the zh-CN ones run
 * through OpenCC, Simplified → Traditional with Taiwan phrasing (`twp`), the
 * same conversion the web app's zh-TW messages come from.
 */

let converter: ((text: string) => string) | null = null;

/** Simplified Chinese text in Traditional Chinese, Taiwan usage. */
export function toTaiwanTraditional(text: string): string {
  converter ??= Converter({ from: "cn", to: "twp" });
  return converter(text);
}

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
