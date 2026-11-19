"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ScheduleRule } from "@sourceweft/contracts/scheduled-tasks";

/** Names a weekday (1 Monday ... 7 Sunday) in the page's language. */
export function weekdayName(
  locale: string,
  day: number,
  width: "long" | "short" = "short",
) {
  // 2026-11-02 is a Monday.
  return new Intl.DateTimeFormat(locale, {
    weekday: width,
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 10, 1 + day)));
}

/** Words for rules and instants, in the page's language and the task's zone. */
export function useScheduleText() {
  const t = useTranslations("dashboardScheduled");
  const locale = useLocale();

  const formatInstant = useCallback(
    (iso: string | null, timeZone?: string) => {
      if (!iso) return "";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        ...(timeZone ? { timeZone } : {}),
      }).format(date);
    },
    [locale],
  );

  const describeRule = useCallback(
    (rule: ScheduleRule, timeZone: string) => {
      switch (rule.kind) {
        case "manual":
          return t("rule.manual");
        case "daily":
          return t("rule.daily", { time: rule.time });
        case "weekdays":
          return t("rule.weekdays", { time: rule.time });
        case "weekly":
          return t("rule.weekly", {
            days: rule.days.map((day) => weekdayName(locale, day)).join(", "),
            time: rule.time,
          });
        case "cron":
          return t("rule.cron", { expr: rule.expr });
        case "once":
          return t("rule.once", { at: formatInstant(rule.at, timeZone) });
      }
    },
    [formatInstant, locale, t],
  );

  return { describeRule, formatInstant };
}
