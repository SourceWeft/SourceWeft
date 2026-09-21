"use client";

import * as React from "react";
import { Flag } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { SkillReportForm } from "./skill-report-form";

/**
 * "Report" on one review, for the dashboard's list and the public page:
 * opens the shared report form for that review. Signed out, the form asks
 * for a contact address. Reopening starts afresh.
 */
export function SkillReviewReportLink({
  slug,
  reviewId,
  signedIn,
}: {
  slug: string;
  reviewId: string;
  signedIn: boolean;
}) {
  const t = useTranslations("dashboardSkillReports");
  const [open, setOpen] = React.useState(false);
  // A new key per opening, so a sent report does not greet the next one.
  const [attempt, setAttempt] = React.useState(0);
  return (
    <>
      <button
        type="button"
        data-testid="skill-review-report"
        className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => {
          setAttempt((value) => value + 1);
          setOpen(true);
        }}
      >
        <Flag aria-hidden className="size-3" />
        {t("button.label")}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("review.title")}</DialogTitle>
            <DialogDescription>{t("review.description")}</DialogDescription>
          </DialogHeader>
          <SkillReportForm
            key={attempt}
            slug={slug}
            reviewId={reviewId}
            signedIn={signedIn}
            onDone={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
