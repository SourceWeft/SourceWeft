"use client";

import * as React from "react";
import { Flag } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { SkillReportForm } from "../../../../dashboard/skills/_components/community/skill-report-form";
import { publicReviewsCopy as copy } from "./public-reviews-copy";

/**
 * "Report" on one review: opens the shared report form for that review.
 * Signed out, the form asks for a contact address. Reopening starts afresh.
 */
export function PublicReviewReportLink({
  slug,
  reviewId,
  signedIn,
}: {
  slug: string;
  reviewId: string;
  signedIn: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  // A new key per opening, so a sent report does not greet the next one.
  const [attempt, setAttempt] = React.useState(0);
  return (
    <>
      <button
        type="button"
        data-testid="public-review-report"
        className="inline-flex items-center gap-1 rounded text-xs text-zinc-500 underline-offset-4 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-white"
        onClick={() => {
          setAttempt((value) => value + 1);
          setOpen(true);
        }}
      >
        <Flag aria-hidden className="size-3" />
        {copy.report}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{copy.reportTitle}</DialogTitle>
            <DialogDescription>{copy.reportDescription}</DialogDescription>
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
