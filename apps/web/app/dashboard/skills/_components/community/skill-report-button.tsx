"use client";

import * as React from "react";
import { Flag } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { skillReportCopy } from "./skill-report-copy";
import { SkillReportForm } from "./skill-report-form";
import type { DashboardSkillSlotProps } from "./slot-props";

const copy = skillReportCopy.button;

/**
 * Report this skill (§17.2). The dashboard is signed in, so the contact
 * email is optional here. Reopening the dialog starts a fresh form.
 */
export function SkillReportButton({ slug }: DashboardSkillSlotProps) {
  const [open, setOpen] = React.useState(false);
  // A new key per opening, so a sent report does not greet the next one.
  const [attempt, setAttempt] = React.useState(0);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setAttempt((value) => value + 1);
          setOpen(true);
        }}
        data-testid="skill-report-button"
      >
        <Flag className="size-3.5" aria-hidden />
        {copy.label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <SkillReportForm
            key={attempt}
            slug={slug}
            signedIn
            onDone={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
