import type { SkillRunErrorClass } from "@sourceweft/contracts";
import type { Locale } from "@sourceweft/i18n/locales";

/**
 * Copy for the public page's sandbox run stats (§17.5), per UI locale. Kept in
 * its own module until the i18n pass moves it into messages.
 */
export type PublicRunStatsCopy = {
  heading: string;
  ran: (runs: string, runCount: number, days: number) => string;
  succeeded: (percent: string) => string;
  commonIssue: (label: string) => string;
  errorLabel: (
    errorClass: SkillRunErrorClass,
    subject: string | null,
  ) => string;
  separator: string;
};

const en: PublicRunStatsCopy = {
  heading: "Sandbox runs",
  ran: (runs, runCount, days) =>
    `Ran ${runs} ${runCount === 1 ? "time" : "times"} in SourceWeft sandboxes in the last ${days} days`,
  succeeded: (percent) => `${percent} succeeded`,
  commonIssue: (label) => `Common issue: ${label}`,
  errorLabel: (errorClass, subject) => {
    switch (errorClass) {
      case "missing_dependency":
        return subject ? `missing ${subject}` : "a missing dependency";
      case "timeout":
        return "timed out";
      case "permission":
        return "permission denied";
      case "other":
        return "other errors";
    }
  },
  separator: " · ",
};

const zhCN: PublicRunStatsCopy = {
  heading: "沙箱运行",
  ran: (runs, _runCount, days) =>
    `近 ${days} 天在 SourceWeft 沙箱中运行 ${runs} 次`,
  succeeded: (percent) => `成功率 ${percent}`,
  commonIssue: (label) => `常见问题：${label}`,
  errorLabel: (errorClass, subject) => {
    switch (errorClass) {
      case "missing_dependency":
        return subject ? `缺少 ${subject}` : "缺少依赖";
      case "timeout":
        return "运行超时";
      case "permission":
        return "权限不足";
      case "other":
        return "其他错误";
    }
  },
  separator: " · ",
};

const zhTW: PublicRunStatsCopy = {
  heading: "沙箱執行",
  ran: (runs, _runCount, days) =>
    `近 ${days} 天在 SourceWeft 沙箱中執行 ${runs} 次`,
  succeeded: (percent) => `成功率 ${percent}`,
  commonIssue: (label) => `常見問題：${label}`,
  errorLabel: (errorClass, subject) => {
    switch (errorClass) {
      case "missing_dependency":
        return subject ? `缺少 ${subject}` : "缺少相依套件";
      case "timeout":
        return "執行逾時";
      case "permission":
        return "權限不足";
      case "other":
        return "其他錯誤";
    }
  },
  separator: " · ",
};

const byLocale: Record<Locale, PublicRunStatsCopy> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

export function publicRunStatsCopy(locale: Locale): PublicRunStatsCopy {
  return byLocale[locale] ?? en;
}
