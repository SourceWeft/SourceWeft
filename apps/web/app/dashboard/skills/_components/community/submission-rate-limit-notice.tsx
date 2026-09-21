"use client";

import { Clock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { SkillSubmission } from "@sourceweft/contracts";
import { SKILL_SUBMISSION_RATE_LIMITED_CODE } from "@sourceweft/contracts";

/** "HH:MM" in the viewer's time zone; null for a missing or bad time. */
export function formatResumeTime(
  resumeAt: string | undefined,
  locale?: string,
): string | null {
  if (!resumeAt) return null;
  const date = new Date(resumeAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * An import waiting for GitHub's rate limit to lift: the submission is back
 * in `queued` with `GITHUB_RATE_LIMITED` and `resumeAt`, and runs again by
 * itself then. Nothing for any other submission.
 */
export function SubmissionRateLimitNotice({
  submission,
  locale,
}: {
  submission: Pick<SkillSubmission, "status" | "error">;
  /** Defaults to the active locale. */
  locale?: string;
}) {
  const t = useTranslations("dashboardSkillsMarketAdmin");
  const activeLocale = useLocale();
  const error = submission.error;
  // A failed one (it waited as long as it may) already shows its error and
  // Retry; only the waiting one needs saying.
  if (
    !error ||
    error.code !== SKILL_SUBMISSION_RATE_LIMITED_CODE ||
    submission.status !== "queued"
  ) {
    return null;
  }
  const time = formatResumeTime(error.resumeAt, locale ?? activeLocale);
  return (
    <p
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="submission-rate-limit"
      role="status"
    >
      <Clock className="size-3.5 shrink-0" />
      {time ? t("rateLimit.notice", { time }) : t("rateLimit.noticeUnknown")}
    </p>
  );
}
