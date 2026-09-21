import type { Locale } from "@sourceweft/i18n/locales";

/**
 * The public skill page's report button and dialog (§17.2). The form inside
 * is the shared `SkillReportForm`, which carries its own text.
 */
export type PublicReportCopy = {
  button: string;
  title: string;
  description: string;
};

const publicReportCopyByLocale: Record<Locale, PublicReportCopy> = {
  en: {
    button: "Report this skill",
    title: "Report this skill",
    description:
      "Tell the SourceWeft market admins about a problem with this skill: a copied work, unsafe behavior, spam, or something broken.",
  },
  "zh-CN": {
    button: "举报此技能",
    title: "举报此技能",
    description:
      "向 SourceWeft 市场管理员反馈此技能的问题：侵权、不安全的行为、垃圾内容或无法使用。",
  },
  "zh-TW": {
    button: "檢舉此技能",
    title: "檢舉此技能",
    description:
      "向 SourceWeft 市場管理員回報此技能的問題：侵權、不安全的行為、垃圾內容或無法使用。",
  },
};

export function publicReportCopy(locale: Locale): PublicReportCopy {
  return publicReportCopyByLocale[locale] ?? publicReportCopyByLocale.en;
}
