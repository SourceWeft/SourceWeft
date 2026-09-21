import { Converter } from "opencc-js/cn2t";
import type { SkillOverviewJson } from "@sourceweft/db";

/**
 * zh-TW overviews are not written by the model: they are the zh-CN ones run
 * through OpenCC, Simplified → Traditional with Taiwan phrasing (`twp`), the
 * same conversion the web app's zh-TW messages come from.
 */

let converter: ((text: string) => string) | null = null;

/**
 * Fixes applied after OpenCC, longest first. `twp` segments 源文件 ("source
 * file") before it sees the word around it, so 资源文件 / 开源文件 come out as
 * 資原始檔 / 開原始檔. The rest keep overviews in the terms the zh-TW site
 * uses (`apps/web/messages/glossary/zh-TW.json`).
 */
const TAIWAN_CORRECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["資原始檔", "資源檔案"],
  ["開原始檔", "開源檔案"],
  ["大模型", "大型語言模型"],
  ["令牌", "權杖"],
  ["憑據", "憑證"],
];

/** Simplified Chinese text in Traditional Chinese, Taiwan usage. */
export function toTaiwanTraditional(text: string): string {
  converter ??= Converter({ from: "cn", to: "twp" });
  let converted = converter(text);
  for (const [from, to] of TAIWAN_CORRECTIONS) {
    converted = converted.replaceAll(from, to);
  }
  return converted;
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
