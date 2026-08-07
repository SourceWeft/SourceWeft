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

/**
 * Lets a user contribute a skill by GitHub URL to the community registry. The
 * backend fetches, statically analyzes, and safety-scans it (never storing the
 * body — index-only), then either indexes it immediately or routes it to review.
 * See docs/architecture/skill-registry-index.md §3.
 */
export function SubmitSkillDialog({
  workspaceId,
  onSubmitted,
}: {
  workspaceId: string | null;
  onSubmitted?: () => void | Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [repoUrl, setRepoUrl] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit() {
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      toast.error("Enter a public GitHub repository URL.");
      return;
    }
    if (!workspaceId) {
      toast.error("Select a workspace before submitting a skill.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await contentClient.submitRegistrySkill(workspaceId, {
        repoUrl: trimmed,
      });
      if (result.status === "indexed") {
        toast.success(
          result.slug ? `Indexed: ${result.slug}` : "Skill indexed.",
        );
      } else {
        toast.success("Submitted — queued for review.");
      }
      setRepoUrl("");
      setOpen(false);
      await onSubmitted?.();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Submission failed. Make sure this is a public GitHub skill repository.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="h-8 gap-1.5 px-2.5 text-xs" size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" />
          Submit skill
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit a skill</DialogTitle>
          <DialogDescription>
            Paste a public GitHub repository link. We index the skill by
            reference — parsing its SKILL.md frontmatter and running a safety scan
            without storing its contents. Clean skills are indexed directly;
            flagged ones go to manual review.
          </DialogDescription>
        </DialogHeader>
        <Input
          onChange={(event) => setRepoUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !submitting) {
              void handleSubmit();
            }
          }}
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
        />
        <DialogFooter>
          <Button
            disabled={submitting || !workspaceId}
            onClick={() => void handleSubmit()}
            type="button"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
