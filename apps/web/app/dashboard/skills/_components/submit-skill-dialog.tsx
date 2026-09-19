"use client";

import * as React from "react";
import {
  registrySkillResultSchema,
  type RegistrySkillResult,
} from "@sourceweft/contracts";
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
  const [results, setResults] = React.useState<RegistrySkillResult[]>([]);
  const [failure, setFailure] = React.useState<string | null>(null);

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
    setResults([]);
    setFailure(null);
    try {
      const result = await contentClient.submitRegistrySkill(workspaceId, {
        repoUrl: trimmed,
      });
      setResults(result.skills);
      await onSubmitted?.();
    } catch (error) {
      const details =
        error && typeof error === "object" && "details" in error
          ? error.details
          : null;
      const parsed = registrySkillResultSchema
        .array()
        .safeParse(
          details && typeof details === "object" && "skills" in details
            ? details.skills
            : undefined,
        );
      if (parsed.success) setResults(parsed.data);
      else
        setFailure(
          `${error instanceof Error ? error.message : "Submission interrupted."} Some items may already be saved; refresh the catalog before retrying.`,
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
            for review.
          </DialogDescription>
        </DialogHeader>
        <Input
          onChange={(event) => setRepoUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !submitting) {
              void handleSubmit();
            }
          }}
          aria-label="GitHub skill repository"
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
        />
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {results.length ? (
          <section aria-label="Import results" className="space-y-3 text-sm">
            <p role="status">
              {results.filter((r) => r.status === "indexed").length} indexed ·{" "}
              {results.filter((r) => r.status === "queued").length} awaiting
              review · {results.filter((r) => r.status === "failed").length}{" "}
              failed
            </p>
            {results.map((result, index) => (
              <div
                key={`${result.sourcePath}-${index}`}
                className="rounded-md border p-3"
              >
                <p className="font-medium">
                  {result.name ?? result.sourcePath ?? "Skill"} —{" "}
                  {result.status}
                </p>
                <p className="text-xs text-muted-foreground">
                  {result.sourcePath || "Repository root"}
                  {result.version ? ` · ${result.version}` : ""}
                </p>
                {result.diagnostics.map((d, i) => (
                  <p
                    key={i}
                    className={
                      d.severity === "error"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    {d.file}
                    {d.line
                      ? `:${d.line}${d.column ? `:${d.column}` : ""}`
                      : ""}{" "}
                    {d.message}
                  </p>
                ))}
                {result.flags.length ? (
                  <p>Review flags: {result.flags.join(", ")}</p>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
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
