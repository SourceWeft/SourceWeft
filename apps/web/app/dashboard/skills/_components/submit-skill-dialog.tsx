"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
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
      toast.error("Enter a public GitHub repository URL.");
      return;
    }
    if (!workspaceId) {
      toast.error("Select a workspace before submitting a skill.");
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
        error instanceof Error ? error.message : "The import was not started.",
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
          Submit skill
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Submit a skill</DialogTitle>
          <DialogDescription>
            Import skills from a public GitHub repository at a fixed version. We
            store the skill files and check them before use. Flagged skills wait
            for review. The import runs in the background — you can close this
            and find it under My submissions.
          </DialogDescription>
        </DialogHeader>
        <Input
          onChange={(event) => setSource(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) {
              void handleSubmit();
            }
          }}
          aria-label="GitHub skill repository"
          placeholder="https://github.com/owner/repo"
          value={source}
        />
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {active ? (
          <section aria-label="Import" className="space-y-3">
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
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
