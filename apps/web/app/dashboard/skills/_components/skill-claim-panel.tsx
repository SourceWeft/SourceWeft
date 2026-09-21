"use client";

import * as React from "react";
import Link from "next/link";
import { BadgeCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { SkillClaimRepository } from "@sourceweft/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sourceweft/ui-web/components/ui/alert-dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import {
  getSkillClaims,
  removeClaimedRepoFromMarket,
} from "../../../../lib/skill-claims";
import {
  claimErrorMessage,
  claimPageHref,
  claimPanelView,
} from "./skill-market-standing";
import { skillsClaimCopy } from "./skills-claim-copy";

const copy = skillsClaimCopy.panel;

/**
 * Who stands behind a community skill's repository, on the skill's page: its
 * author's claim, or a way for the author to make one. The verified claimant
 * can also take every skill of the repository off the public market.
 *
 * A best-effort aid like the owner and admin panels: if the claim state
 * cannot be read, nothing is shown.
 */
export function SkillClaimPanel({
  onChanged,
  skillId,
  workspaceId,
}: {
  onChanged?: () => void;
  skillId: string;
  workspaceId: string;
}) {
  const [repository, setRepository] =
    React.useState<SkillClaimRepository | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setRepository(null);
    getSkillClaims(workspaceId, { skillId })
      .then((result) => {
        if (!cancelled) setRepository(result.repository);
      })
      .catch(() => {
        // Nothing to offer; the rest of the page does not depend on this.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, skillId]);

  const view = claimPanelView(repository);
  if (view.kind === "hidden") return null;

  async function remove(claimId: string) {
    setBusy(true);
    try {
      const result = await removeClaimedRepoFromMarket(workspaceId, claimId);
      toast.success(copy.removedToast(result.skillCount));
      onChanged?.();
    } catch (error) {
      toast.error(claimErrorMessage(error, copy.removeFailed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={copy.title}
      className="rounded-2xl border border-border bg-background p-4 shadow-xs"
      data-testid="skill-claim-panel"
    >
      <h2 className="text-sm font-semibold text-foreground">{copy.title}</h2>
      {view.kind === "unclaimed" ? (
        <div className="mt-2 space-y-3 text-xs">
          <p className="text-muted-foreground">{copy.unclaimedBody}</p>
          <Button asChild className="w-full" size="sm" variant="outline">
            <Link href={claimPageHref(view.repo)}>{copy.claimLink}</Link>
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <BadgeCheck className="size-4 text-primary" />
            {view.kind === "claimedByYou"
              ? copy.claimedByYou
              : copy.claimedByAuthor}
          </p>
          {view.kind === "claimedByYou" && view.claimId ? (
            <>
              <p className="text-muted-foreground">{copy.removeHint}</p>
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {copy.remove}
              </Button>
              <Link
                className="block text-muted-foreground underline-offset-2 hover:underline"
                href={claimPageHref(view.repo)}
              >
                {copy.manageLink}
              </Link>
            </>
          ) : null}
        </div>
      )}

      {view.kind === "claimedByYou" && view.claimId ? (
        <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.confirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {copy.confirmBody(view.repo)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmOpen(false);
                  const claimId = view.claimId;
                  if (claimId) void remove(claimId);
                }}
              >
                {copy.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}
