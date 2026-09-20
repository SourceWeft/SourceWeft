"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";

import { contentClient } from "../../../../lib/sdk";
import {
  isSubmissionInFlight,
  SubmissionDetail,
  SubmissionStatusBadge,
  type SkillSubmissionsController,
} from "./skill-submissions";

/**
 * Lets a user contribute a skill by GitHub URL to the community registry. The
 * import runs as a background job — fetch, static analysis, safety scan, then
 * either indexed or routed to review (docs/architecture/skill-registry-index.md
 * §3) — so this dialog only STARTS it and then shows the submission the skills
 * page is already watching. Closing it cancels nothing; the import stays listed
 * under "My submissions".
 */
export function SubmitSkillDialog({
  workspaceId,
  submissions,
}: {
  workspaceId: string | null;
  submissions: SkillSubmissionsController;
}) {
  const t = useTranslations("dashboardSkills");
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  const active = activeId
    ? (submissions.items.find((item) => item.id === activeId) ?? null)
    : null;
  const busy = submitting || (active ? isSubmissionInFlight(active) : false);

  async function handleSubmit() {
    const trimmed = source.trim();
    if (!trimmed) {
      toast.error(t("submit.enterUrl"));
      return;
    }
    if (!workspaceId) {
      toast.error(t("submit.selectWorkspace"));
      return;
    }
    setSubmitting(true);
    setFailure(null);
    try {
      // Also what a second submit of a source still importing answers with:
      // that same submission, so the dialog simply picks its progress up.
      const { submission } = await contentClient.createSkillSubmission(
        workspaceId,
        { source: trimmed },
      );
      submissions.track(submission);
      setActiveId(submission.id);
    } catch (error) {
      setActiveId(null);
      setFailure(
        error instanceof Error ? error.message : t("submit.notStarted"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button
          className="h-8 gap-1.5 px-2.5 text-xs"
          size="sm"
          variant="outline"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("submit.button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("submit.title")}</DialogTitle>
          <DialogDescription>{t("submit.description")}</DialogDescription>
        </DialogHeader>
        <Input
          onChange={(event) => setSource(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) {
              void handleSubmit();
            }
          }}
          aria-label={t("submit.repoAriaLabel")}
          placeholder="https://github.com/owner/repo"
          value={source}
        />
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {active ? (
          <section aria-label={t("submit.importSection")} className="space-y-3">
            <p className="flex items-center gap-2 text-sm">
              <SubmissionStatusBadge submission={active} />
              <span className="min-w-0 truncate">{active.sourceInput}</span>
            </p>
            <SubmissionDetail
              onRetry={submissions.retry}
              submission={active}
            />
          </section>
        ) : null}
        <DialogFooter>
          <Button
            disabled={busy || !workspaceId}
            onClick={() => void handleSubmit()}
            type="button"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("submit.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
