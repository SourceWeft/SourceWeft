"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { SkillClaimsOverview } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";

import { getSkillClaims, startSkillClaim } from "../../../../lib/skill-claims";
import { workspaceClient } from "../../../../lib/sdk";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { claimErrorMessage } from "../_components/skill-market-standing";
import { ClaimLists } from "./_components/claim-lists";
import { ClaimRepositoryCard } from "./_components/claim-repository-card";
import {
  claimPageSearch,
  claimRepositoryPlan,
  normalizeClaimRepo,
} from "./_components/claim-view";

/**
 * `/dashboard/skills/claim?repo=owner/repo` — where an author claims the
 * GitHub repository their community skills come from. The public skill page
 * links here; so does the panel on a dashboard skill page.
 */
function ClaimPage() {
  const t = useTranslations("dashboardSkillsClaim");
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
      if (generationRef.current === generation) setLoadError(t("page.loadFailed"));
    }
  }, [repo, t, workspaceId]);

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
      setActionError(claimErrorMessage(error, t));
    } finally {
      await load();
      setBusy(false);
    }
  }

  function claim() {
    if (!workspaceId || !repo) return;
    void act(async () => {
      await startSkillClaim(workspaceId, { repo, method: "github_account" });
      toast.success(t("page.verified"));
    });
  }

  const repository = repo ? (overview?.repository ?? null) : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Button
            asChild
            aria-label={t("page.back")}
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
            {t("page.title")}
          </h1>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto grid max-w-5xl gap-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex min-w-0 flex-col gap-4">
              <section className="rounded-2xl border border-border bg-background p-5 shadow-xs">
                <p className="text-sm text-foreground">{t("page.intro")}</p>
                <h2 className="mt-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {t("page.benefitsTitle")}
                </h2>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
                  {(t.raw("page.benefits") as string[]).map((benefit) => (
                    <li key={benefit}>{benefit}</li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("page.benefitsNote")}
                </p>

                <form className="mt-5 flex flex-wrap gap-2" onSubmit={lookUp}>
                  <label className="sr-only" htmlFor="skill-claim-repo">
                    {t("page.repoLabel")}
                  </label>
                  <Input
                    aria-invalid={draftInvalid}
                    autoComplete="off"
                    className="min-w-0 flex-1"
                    id="skill-claim-repo"
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={t("page.repoPlaceholder")}
                    spellCheck={false}
                    value={draft}
                  />
                  <Button disabled={!workspaceId} type="submit" variant="outline">
                    {t("page.lookUp")}
                  </Button>
                </form>
                {draftInvalid || (repoParam && !repo) ? (
                  <p className="mt-2 text-xs text-destructive">
                    {t("page.repoInvalid")}
                  </p>
                ) : null}
              </section>

              {!resolved ? (
                <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                </div>
              ) : !workspaceId ? (
                <p className="text-sm text-muted-foreground">
                  {t("page.noWorkspace")}
                </p>
              ) : loadError ? (
                <div className="space-y-3 text-sm" role="alert">
                  <p className="text-destructive">{loadError}</p>
                  <Button onClick={() => void load()} size="sm" variant="outline">
                    {t("page.retry")}
                  </Button>
                </div>
              ) : repo && overview ? (
                repository ? (
                  <ClaimRepositoryCard
                    busy={busy}
                    error={actionError}
                    onClaim={claim}
                    plan={claimRepositoryPlan(repository)}
                    repository={repository}
                  />
                ) : (
                  <p className="rounded-2xl border border-border bg-background p-5 text-sm text-muted-foreground">
                    {t("page.repoNotFound")}
                  </p>
                )
              ) : null}
            </div>

            {overview ? (
              <ClaimLists
                onChanged={() => void load()}
                overview={overview}
                workspaceId={workspaceId}
              />
            ) : null}
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
