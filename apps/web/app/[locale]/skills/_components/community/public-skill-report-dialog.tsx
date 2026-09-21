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
import { publicReportCopy } from "./public-report-copy";
import type { PublicSkillSlotProps } from "./slot-props";

/**
 * "Report this skill" on the public page: the shared report form in a
 * dialog. A visitor who is not signed in must leave an email address; a
 * signed-in one may. Reopening the dialog starts a fresh form.
 */
export function PublicSkillReportDialog({
  slug,
  signedIn,
  locale,
}: PublicSkillSlotProps) {
  const copy = publicReportCopy(locale);
  const [open, setOpen] = React.useState(false);
  // A new key per opening, so a sent report does not greet the next one.
  const [attempt, setAttempt] = React.useState(0);

  return (
    <>
      <p className="mt-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 font-medium text-zinc-950 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-950 dark:text-white dark:decoration-white/20 dark:hover:decoration-white"
          onClick={() => {
            setAttempt((value) => value + 1);
            setOpen(true);
          }}
          data-testid="public-skill-report-button"
        >
          <Flag className="size-3.5" aria-hidden />
          {copy.button}
        </button>
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <SkillReportForm
            key={attempt}
            slug={slug}
            signedIn={signedIn}
            onDone={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
