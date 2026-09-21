import type { Locale } from "@sourceweft/i18n/locales";
import type { SkillAiOverviewLabels } from "../../../../dashboard/skills/_components/community/skill-ai-overview-view";

/**
 * Strings for the AI overview on the public skill pages (§17.4): the block
 * above SKILL.md and the AI summary on cards. Per locale here until they move
 * into the app's messages.
 */
export type PublicOverviewCopy = {
  block: SkillAiOverviewLabels;
  // On a card whose text is the AI summary rather than the author's own.
  cardSummaryTitle: string;
};

const en: PublicOverviewCopy = {
  block: {
    title: "AI-generated overview",
    explainer:
      "Written by an AI model from this skill's SKILL.md and file list. It can be wrong or incomplete — check the skill's own documentation before relying on it.",
    explainerLabel: "About this overview",
    whatItDoes: "What it does",
    whenToUse: "When to use it",
    requirements: "Requirements",
    englishFallback: "Shown in English: no overview in your language yet.",
  },
  cardSummaryTitle: "AI-generated summary",
};

const zhCN: PublicOverviewCopy = {
  block: {
    title: "AI 生成的概览",
    explainer:
      "由 AI 模型根据该技能的 SKILL.md 和文件列表撰写，可能有误或不完整。使用前请以技能自带的文档为准。",
    explainerLabel: "关于此概览",
    whatItDoes: "功能",
    whenToUse: "适用场景",
    requirements: "运行要求",
    englishFallback: "暂无中文概览，以下为英文版本。",
  },
  cardSummaryTitle: "AI 生成的简介",
};

const zhTW: PublicOverviewCopy = {
  block: {
    title: "AI 產生的概覽",
    explainer:
      "由 AI 模型根據此技能的 SKILL.md 與檔案清單撰寫，可能有誤或不完整。使用前請以技能本身的文件為準。",
    explainerLabel: "關於此概覽",
    whatItDoes: "功能",
    whenToUse: "適用情境",
    requirements: "執行需求",
    englishFallback: "尚無中文概覽，以下為英文版本。",
  },
  cardSummaryTitle: "AI 產生的簡介",
};

const byLocale: Record<Locale, PublicOverviewCopy> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

export function publicOverviewCopy(locale: string): PublicOverviewCopy {
  return byLocale[locale as Locale] ?? en;
}
