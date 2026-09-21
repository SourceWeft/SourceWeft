"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type {
  SkillClaimMethod,
  SkillClaimsOverview,
  StartSkillClaimResponse,
} from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";

import {
  getSkillClaims,
  startSkillClaim,
  verifySkillClaim,
} from "../../../../lib/skill-claims";
import { workspaceClient } from "../../../../lib/sdk";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { claimErrorMessage } from "../_components/skill-market-standing";
import { skillsClaimCopy } from "../_components/skills-claim-copy";
import { ClaimLists } from "./_components/claim-lists";
import { ClaimRepositoryCard } from "./_components/claim-repository-card";
import {
  claimPageSearch,
  claimRepositoryPlan,
  normalizeClaimRepo,
} from "./_components/claim-view";

const copy = skillsClaimCopy.page;

/**
 * `/dashboard/skills/claim?repo=owner/repo` — where an author claims the
 * GitHub repository their community skills come from. The public skill page
 * links here; so does the panel on a dashboard skill page.
 */
function ClaimPage() {
  const dashboardState = useDashboardChatState();
  const router = useRouter();
  const pathname = usePathname();
  const repoParam = useSearchParams().get("repo");
  const repo = normalizeClaimRepo(repoParam);

  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [resolved, setResolved] = React.useState(false);
  const [overview, setOverview] = React.useState<SkillClaimsOverview | null>(
    null,
  );
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState(repoParam ?? "");
  const [draftInvalid, setDraftInvalid] = React.useState(false);
  // The response that issued a token: the only place the token ever exists.
  const [issued, setIssued] = React.useState<StartSkillClaimResponse | null>(
    null,
  );
  const generationRef = React.useRef(0);

  React.useEffect(() => {
    setDraft(repoParam ?? "");
    setDraftInvalid(false);
    setActionError(null);
  }, [repoParam]);

  React.useEffect(() => {
    let cancelled = false;
    async function resolve() {
      if (dashboardState.workspaceId) return dashboardState.workspaceId;
      const current = await workspaceClient.getCurrentContext();
      return current.activeWorkspace?.id ?? null;
    }
    resolve()
      .then((id) => {
        if (!cancelled) setWorkspaceId(id);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceId(null);
      })
      .finally(() => {
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardState.workspaceId]);

  const load = React.useCallback(async () => {
    if (!workspaceId) return;
    const generation = ++generationRef.current;
    setLoadError(null);
    try {
      const result = await getSkillClaims(
        workspaceId,
        repo ? { repo } : {},
      );
      if (generationRef.current === generation) setOverview(result);
    } catch {
      if (generationRef.current === generation) setLoadError(copy.loadFailed);
    }
  }, [repo, workspaceId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function lookUp(event: React.FormEvent) {
    event.preventDefault();
    const next = normalizeClaimRepo(draft);
    if (!next) {
      setDraftInvalid(true);
      return;
    }
    setDraftInvalid(false);
    router.replace(`${pathname}${claimPageSearch(next)}`, { scroll: false });
  }

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(claimErrorMessage(error));
    } finally {
      await load();
      setBusy(false);
    }
  }

  function start(method: SkillClaimMethod) {
    if (!workspaceId || !repo) return;
    void act(async () => {
      const result = await startSkillClaim(workspaceId, { repo, method });
      if (result.verification) {
        setIssued(result);
        toast.success(copy.started);
      } else {
        setIssued(null);
        toast.success(copy.verified);
      }
    });
  }

  function verify(claimId: string) {
    if (!workspaceId) return;
    void act(async () => {
      await verifySkillClaim(workspaceId, claimId);
      setIssued(null);
      toast.success(copy.verified);
    });
  }

  const repository = repo ? (overview?.repository ?? null) : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Button
            asChild
            aria-label={copy.back}
            className="h-8 w-8 rounded-full p-0"
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Link href="/dashboard/skills">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-base font-semibold text-foreground">
            {copy.title}
          </h1>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto grid max-w-5xl gap-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex min-w-0 flex-col gap-4">
              <section className="rounded-2xl border border-border bg-background p-5 shadow-xs">
                <p className="text-sm text-foreground">{copy.intro}</p>
                <h2 className="mt-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {copy.benefitsTitle}
                </h2>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
                  {copy.benefits.map((benefit) => (
                    <li key={benefit}>{benefit}</li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted-foreground">
                  {copy.benefitsNote}
                </p>

                <form className="mt-5 flex flex-wrap gap-2" onSubmit={lookUp}>
                  <label className="sr-only" htmlFor="skill-claim-repo">
                    {copy.repoLabel}
                  </label>
                  <Input
                    aria-invalid={draftInvalid}
                    autoComplete="off"
                    className="min-w-0 flex-1"
                    id="skill-claim-repo"
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={copy.repoPlaceholder}
                    spellCheck={false}
                    value={draft}
                  />
                  <Button disabled={!workspaceId} type="submit" variant="outline">
                    {copy.lookUp}
                  </Button>
                </form>
                {draftInvalid || (repoParam && !repo) ? (
                  <p className="mt-2 text-xs text-destructive">
                    {copy.repoInvalid}
                  </p>
                ) : null}
              </section>

              {!resolved ? (
                <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                </div>
              ) : !workspaceId ? (
                <p className="text-sm text-muted-foreground">
                  {copy.noWorkspace}
                </p>
              ) : loadError ? (
                <div className="space-y-3 text-sm" role="alert">
                  <p className="text-destructive">{loadError}</p>
                  <Button onClick={() => void load()} size="sm" variant="outline">
                    {copy.retry}
                  </Button>
                </div>
              ) : repo && overview ? (
                repository ? (
                  <ClaimRepositoryCard
                    busy={busy}
                    error={actionError}
                    onStart={start}
                    onVerify={verify}
                    plan={claimRepositoryPlan(repository, issued)}
                    repository={repository}
                  />
                ) : (
                  <p className="rounded-2xl border border-border bg-background p-5 text-sm text-muted-foreground">
                    {copy.repoNotFound}
                  </p>
                )
              ) : null}
            </div>

            {overview ? <ClaimLists overview={overview} /> : null}
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}

export default function SkillClaimPage() {
  // `useSearchParams` needs a boundary when the route is prerendered.
  return (
    <React.Suspense fallback={null}>
      <ClaimPage />
    </React.Suspense>
  );
}
