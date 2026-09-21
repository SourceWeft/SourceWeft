"use client";

import { RegistryVersions } from "../_components/registry-versions";
import { SkillAvatar } from "../_components/skill-avatar";
import { SkillAiOverview } from "../_components/community/skill-ai-overview";
import { SkillMarketEvents } from "../_components/community/skill-market-events";
import { SkillOverviewAdmin } from "../_components/community/skill-overview-admin";
import { SkillReportButton } from "../_components/community/skill-report-button";
import { SkillReviews } from "../_components/community/skill-reviews";
import { SkillRunStats } from "../_components/community/skill-run-stats";
import { SkillClaimPanel } from "../_components/skill-claim-panel";

import { SkillContentRestricted } from "../_components/skill-content-restricted";
import {
  hasInstallIntent,
  resolveInstallIntent,
  withoutInstallIntent,
} from "../_components/skill-install-intent";
import { SkillIntroduction } from "../_components/skill-introduction";
import { SkillMarketAdminPanel } from "../_components/skill-market-admin-panel";
import { claimRepoOfSourceUrl } from "../_components/skill-market-standing";
import { SkillOwnerListing } from "../_components/skill-owner-listing";
import { SkillMarketFacts } from "../_components/skill-market-facts";
import {
  formatInstallCount,
  skillCategoryName,
} from "../_components/skills-market-browse";

import * as React from "react";
import Link from "next/link";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type {
  RegistryVersionDetail,
  SkillCatalogCategory,
} from "@sourceweft/contracts";
import { HttpClientError } from "@sourceweft/sdk";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient, workspaceClient } from "../../../../lib/sdk";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { SkillIcon } from "../../../_components/site-icons";

type SkillCatalogItem = Awaited<
  ReturnType<typeof contentClient.listSkillsCatalog>
>["items"][number];

type SkillCatalogDetail = Awaited<
  ReturnType<typeof contentClient.getSkillCatalogDetail>
>;

type ResolvedWorkspace = {
  id: string;
  name: string;
};

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSkillNotFound(error: unknown) {
  return error instanceof HttpClientError && error.code === "SKILL_NOT_FOUND";
}

export default function SkillDetailPage() {
  const t = useTranslations("dashboardSkills");
  const tm = useTranslations("dashboardSkillsMarket");
  const publisherLabel = (sourceType: SkillCatalogItem["sourceType"]) => {
    if (sourceType === "builtin") return t("publisher.official");
    if (sourceType === "team_custom") return t("publisher.team");
    if (sourceType === "registry_github") return t("publisher.community");
    return t("publisher.workspace");
  };
  const visibilityLabel = (visibility: SkillCatalogItem["visibility"]) =>
    t.has(`visibility.${visibility}`)
      ? t(`visibility.${visibility}`)
      : visibility.charAt(0).toUpperCase() + visibility.slice(1);
  const params = useParams<{ slug?: string | string[] }>();
  const rawSlug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const slug = rawSlug ? safeDecode(rawSlug) : null;
  const dashboardState = useDashboardChatState();
  const [workspace, setWorkspace] = React.useState<ResolvedWorkspace | null>(
    null,
  );
  const [detail, setDetail] = React.useState<SkillCatalogDetail | null>(null);
  const [categories, setCategories] = React.useState<SkillCatalogCategory[]>(
    [],
  );
  const [isResolvingWorkspace, setIsResolvingWorkspace] = React.useState(true);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [isUninstalling, setIsUninstalling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const detailGenerationRef = React.useRef(0);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [installPromptOpen, setInstallPromptOpen] = React.useState(false);
  // A community skill has many versions; the one being read is reported by the
  // version control below, as in the gallery's dialog.
  const [registryDetail, setRegistryDetail] =
    React.useState<RegistryVersionDetail | null>(null);
  const [versionViewed, setVersionViewed] = React.useState(false);
  const handleVersionView = React.useCallback(
    (value: RegistryVersionDetail | null) => {
      setRegistryDetail(value);
      if (value) setVersionViewed(true);
    },
    [],
  );
  const versionsRef = React.useRef<HTMLDivElement | null>(null);
  // Bumped when the author removes the repository from the market, so the
  // owner switch below reads its (now held) listing again.
  const [claimRevision, setClaimRevision] = React.useState(0);

  const resolveWorkspace = React.useCallback(async () => {
    if (dashboardState.workspaceId) {
      return {
        id: dashboardState.workspaceId,
        name: dashboardState.workspaceName,
      };
    }

    const current = await workspaceClient.getCurrentContext();
    if (current.activeWorkspace) {
      return {
        id: current.activeWorkspace.id,
        name: current.activeWorkspace.name,
      };
    }
    return null;
  }, [dashboardState.workspaceId, dashboardState.workspaceName]);

  const loadDetail = React.useCallback(async () => {
    const generation = ++detailGenerationRef.current;
    setError(null);
    setIsResolvingWorkspace(true);
    try {
      const resolved = await resolveWorkspace();
      if (detailGenerationRef.current !== generation) {
        return;
      }
      setWorkspace(resolved);
      if (!resolved) {
        setDetail(null);
        return;
      }
      if (!slug) {
        setDetail(null);
        setError(t("detail.errors.slugMissing"));
        return;
      }

      setIsLoading(true);
      // Resolved by slug on the server. Listing the catalog to find it here
      // only ever saw one page, so any skill past it read as missing.
      const result = await contentClient.getSkillCatalogDetailBySlug(
        resolved.id,
        slug,
      );
      if (detailGenerationRef.current !== generation) {
        return;
      }
      setDetail(result);
    } catch (loadError) {
      if (detailGenerationRef.current !== generation) {
        return;
      }
      setDetail(null);
      setError(
        isSkillNotFound(loadError)
          ? t("detail.errors.notFound")
          : loadError instanceof Error
            ? loadError.message
            : t("detail.errors.loadFailed"),
      );
    } finally {
      if (detailGenerationRef.current === generation) {
        setIsResolvingWorkspace(false);
        setIsLoading(false);
      }
    }
  }, [resolveWorkspace, slug, t]);

  React.useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // Names for the category slugs a community skill carries (and the choices in
  // the market admin panel). Missing names fall back to the slug, so a failure
  // here costs nothing but polish.
  const activeWorkspaceId = workspace?.id ?? null;
  React.useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    void contentClient
      .listSkillCatalogCategories(activeWorkspaceId)
      .then((result) => {
        if (!cancelled) setCategories(result.items);
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  // After a market admin action: the header's facts (verified, categories) may
  // have changed. In place and best-effort — no spinner, no error.
  async function refreshDetail() {
    if (!workspace || !slug) return;
    const generation = detailGenerationRef.current;
    try {
      const result = await contentClient.getSkillCatalogDetailBySlug(
        workspace.id,
        slug,
      );
      if (detailGenerationRef.current === generation) setDetail(result);
    } catch {
      // Keep what is on screen.
    }
  }

  async function installSkill() {
    if (!workspace || !detail || detail.skill.enabled) return;
    if (detail.skill.installable === false) return;

    if (viewedVersion && viewedVersion.status !== "published") return;

    setIsInstalling(true);
    try {
      const item = detail.skill;
      const result = await contentClient.enableWorkspaceSkill(workspace.id, {
        skillId: item.skillId,
        // The version on screen — the recommended one unless another was picked.
        skillVersionId: viewedVersion?.id ?? item.skillVersionId,
      });
      setDetail((currentDetail) =>
        currentDetail
          ? {
              ...currentDetail,
              skill: {
                ...currentDetail.skill,
                enabled: result.workspaceSkill.enabled,
                enabledWorkspaceSkillId: result.workspaceSkill.id,
              },
            }
          : currentDetail,
      );
      toast.success(t("toasts.installed"));
      if (detail.contentRestricted) {
        // Only a skill that is not publicly listed withholds its text, and
        // installing is what gives this workspace a claim to it. Fetched in
        // place: the install already succeeded, so a failure here only leaves
        // the notice up until the next load.
        const generation = detailGenerationRef.current;
        void contentClient
          .getSkillCatalogDetailBySlug(workspace.id, item.slug)
          .then((result) => {
            if (detailGenerationRef.current === generation) setDetail(result);
          })
          .catch(() => undefined);
      }
    } catch (installError) {
      toast.error(
        installError instanceof Error
          ? installError.message
          : t("toasts.installFailed"),
      );
    } finally {
      setIsInstalling(false);
    }
  }

  async function uninstallSkill() {
    if (!workspace || !detail || !detail.skill.enabled) return;
    if (
      detail.skill.sourceType === "builtin" &&
      detail.skill.installable === false
    )
      return;
    if (!detail.skill.enabledWorkspaceSkillId) {
      toast.error(t("toasts.installRecordMissing"));
      return;
    }

    setIsUninstalling(true);
    try {
      await contentClient.deleteWorkspaceSkill(
        workspace.id,
        detail.skill.enabledWorkspaceSkillId,
      );
      setDetail((currentDetail) =>
        currentDetail
          ? {
              ...currentDetail,
              skill: {
                ...currentDetail.skill,
                enabled: false,
              },
            }
          : currentDetail,
      );
      toast.success(t("toasts.uninstalled"));
    } catch (uninstallError) {
      toast.error(
        uninstallError instanceof Error
          ? uninstallError.message
          : t("toasts.uninstallFailed"),
      );
    } finally {
      setIsUninstalling(false);
    }
  }

  const pageLoading = isResolvingWorkspace || isLoading;
  const isRegistrySkill = detail?.skill.sourceType === "registry_github";
  const viewedVersion = isRegistrySkill ? registryDetail?.version : undefined;
  // Until the version control has loaded something, the page's own documents
  // (the recommended version) stand in. After that a version's documents are
  // never shown under another version's name: no fallback while one loads.
  const documents = isRegistrySkill
    ? (registryDetail ?? (versionViewed ? null : detail))
    : detail;
  const skillContent = documents?.skillContent ?? "";
  const contentRestricted = documents?.contentRestricted === true;
  const canManageInstall = detail?.skill.installable !== false;
  // Only a published version can be installed; one already installed can
  // always be removed, whatever is being read.
  const viewedInstallable =
    !viewedVersion || viewedVersion.status === "published";

  // `?install=1`: ask once, then leave the URL. Never installs by itself.
  const installRequested = hasInstallIntent(searchParams);
  const installIntent = resolveInstallIntent({
    requested: installRequested,
    loading: pageLoading,
    skill: error ? null : (detail?.skill ?? null),
  });
  // Once per arrival: the URL only changes a moment after `router.replace`, and
  // a render in between (Cancel, say) must not ask again. A later arrival with
  // the param is a new request.
  const installIntentHandledRef = React.useRef(false);
  const search = searchParams.toString();
  React.useEffect(() => {
    if (!installRequested) {
      installIntentHandledRef.current = false;
      return;
    }
    if (installIntentHandledRef.current) return;
    if (installIntent !== "prompt" && installIntent !== "strip") return;
    installIntentHandledRef.current = true;
    if (installIntent === "prompt") setInstallPromptOpen(true);
    router.replace(
      withoutInstallIntent(
        pathname,
        new URLSearchParams(search),
        window.location.hash,
      ),
      { scroll: false },
    );
  }, [installIntent, installRequested, pathname, router, search]);
  // The prompt is only about installing; once installed there is nothing to ask.
  const showInstallPrompt =
    installPromptOpen && !!detail && !detail.skill.enabled && canManageInstall;
  const installPending = isInstalling || isUninstalling;
  const installBlocked =
    !!detail && !detail.skill.enabled && !viewedInstallable;

  // `#versions` (the hub's "Update available" badge): the section renders after
  // the skill loads, which is too late for the browser's own anchor scroll.
  const detailLoaded = detail !== null;
  React.useEffect(() => {
    if (detailLoaded && window.location.hash === "#versions") {
      versionsRef.current?.scrollIntoView({ block: "start" });
    }
  }, [detailLoaded]);

  // Reviews, AI overview, run stats and reports exist for community skills.
  const communitySlot =
    detail?.skill.sourceType === "registry_github" && workspace
      ? {
          skillId: detail.skill.skillId,
          catalogId: detail.skill.catalogId,
          slug: detail.skill.slug,
          workspaceId: workspace.id,
        }
      : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                asChild
                aria-label={t("detail.back")}
                className="h-8 w-8 rounded-full p-0"
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Link href="/dashboard/skills">
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              </Button>
              {detail ? (
                <>
                  <SkillAvatar item={detail.skill} />
                  <div className="min-w-0">
                    <h1 className="truncate text-base font-semibold text-foreground">
                      {detail.skill.displayName}
                    </h1>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge
                        className="h-5 px-1.5 text-[10px]"
                        variant="outline"
                      >
                        {publisherLabel(detail.skill.sourceType)}
                      </Badge>
                      {detail.skill.enabled && canManageInstall ? (
                        <Badge
                          className="h-5 px-1.5 text-[10px]"
                          variant="secondary"
                        >
                          {t("status.installed")}
                        </Badge>
                      ) : null}
                      <SkillMarketFacts
                        categories={categories}
                        item={detail.skill}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="min-w-0">
                  <h1 className="truncate text-base font-semibold text-foreground">
                    {t("detail.titleFallback")}
                  </h1>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {detail && canManageInstall ? (
                <Button
                  className={cn(
                    "h-8 px-3 text-xs",
                    // The button an `?install=1` link is asking about.
                    showInstallPrompt &&
                      "ring-2 ring-primary ring-offset-2 ring-offset-background",
                  )}
                  disabled={installPending || installBlocked}
                  onClick={() =>
                    void (detail.skill.enabled
                      ? uninstallSkill()
                      : installSkill())
                  }
                  size="sm"
                  type="button"
                  variant={detail.skill.enabled ? "secondary" : "default"}
                >
                  {isInstalling || isUninstalling ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : detail.skill.enabled ? (
                    <Trash2 className="h-4 w-4" />
                  ) : (
                    <SkillIcon className="h-4 w-4" />
                  )}
                  {detail.skill.enabled ? t("actions.uninstall") : t("actions.install")}
                </Button>
              ) : null}
            </div>
          </div>

          {showInstallPrompt && detail ? (
            <section
              aria-label={tm("updates.installPromptLabel")}
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs"
              data-testid="skill-install-prompt"
            >
              <p className="min-w-0 font-medium text-foreground">
                {tm("updates.installPrompt", {
                  name: detail.skill.displayName,
                })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  className="h-7 px-3 text-xs"
                  disabled={installPending}
                  onClick={() => setInstallPromptOpen(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {tm("updates.installCancel")}
                </Button>
                <Button
                  className="h-7 px-3 text-xs"
                  disabled={installPending || installBlocked}
                  onClick={() => void installSkill()}
                  size="sm"
                  type="button"
                >
                  {isInstalling ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {tm("updates.installConfirm")}
                </Button>
              </div>
            </section>
          ) : null}

          {error ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-300">
              {error}
            </p>
          ) : null}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="flex min-w-0 flex-col gap-4">
              {detail && isRegistrySkill && workspace ? (
                <div id="versions" ref={versionsRef}>
                  <RegistryVersions
                    key={detail.skill.skillId}
                    workspaceId={workspace.id}
                    catalogId={detail.skill.catalogId}
                    initialVersionId={detail.skill.skillVersionId}
                    // The catalog resolves a slug to the published current
                    // version; an owner's unpublished draft is not an update.
                    currentVersionId={
                      detail.skill.installable === false
                        ? null
                        : detail.skill.skillVersionId
                    }
                    refreshKey={`${detail.skill.enabledWorkspaceSkillId ?? ""}:${detail.skill.enabled}`}
                    onView={handleVersionView}
                    onChanged={() => void refreshDetail()}
                  />
                </div>
              ) : null}
              <article className="min-w-0 rounded-2xl border border-border bg-background shadow-xs">
                {pageLoading ? (
                  <div className="flex items-center justify-center px-5 py-16 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("loading.skill")}
                  </div>
                ) : error ? (
                  <div role="alert" className="space-y-3 px-5 py-10 text-sm">
                    <p className="text-destructive">{error}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loadDetail()}
                    >
                      {t("actions.retry")}
                    </Button>
                  </div>
                ) : (
                  <Tabs className="gap-0" defaultValue="overview">
                    <div className="border-b border-border px-5 py-3">
                      <TabsList className="h-8" variant="line">
                        <TabsTrigger
                          className="px-2.5 text-xs"
                          value="overview"
                        >
                          {t("tabs.overview")}
                        </TabsTrigger>
                        <TabsTrigger className="px-2.5 text-xs" value="skill">
                          SKILL.md
                        </TabsTrigger>
                      </TabsList>
                    </div>
                    <TabsContent className="m-0 px-5 py-5" value="overview">
                      {communitySlot ? (
                        <SkillAiOverview {...communitySlot} />
                      ) : null}
                      {contentRestricted && detail ? (
                        <SkillContentRestricted
                          description={detail.skill.description}
                          sourceUrl={detail.skill.sourceUrl}
                        />
                      ) : detail && documents ? (
                        <SkillIntroduction
                          // Version documents are immutable: never share streaming block state between two of them.
                          key={`${viewedVersion?.id ?? detail.skill.skillVersionId}:overview`}
                          {...documents}
                          displayName={detail.skill.displayName}
                          description={detail.skill.description}
                        />
                      ) : null}
                    </TabsContent>
                    <TabsContent className="m-0 px-5 py-5" value="skill">
                      {contentRestricted ? (
                        <SkillContentRestricted
                          sourceUrl={detail?.skill.sourceUrl}
                        />
                      ) : !documents ? (
                        <div className="flex items-center py-10 text-sm text-muted-foreground">
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t("loading.skill")}
                        </div>
                      ) : skillContent ? (
                        <MessageResponse
                          key={`${viewedVersion?.id ?? detail?.skill.skillVersionId ?? ""}:skill`}
                          className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left"
                        >
                          {skillContent}
                        </MessageResponse>
                      ) : (
                        <div className="py-10 text-sm text-muted-foreground">
                          {t("content.noSkillMd")}
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>
                )}
              </article>
              {communitySlot ? <SkillReviews {...communitySlot} /> : null}
            </div>

            <div className="flex h-fit min-w-0 flex-col gap-4">
              <aside className="h-fit rounded-2xl border border-border bg-background p-4 shadow-xs">
                <h2 className="text-sm font-semibold text-foreground">
                  {t("fields.heading")}
                </h2>
                {detail ? (
                  <dl className="mt-3 space-y-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">{t("fields.name")}</dt>
                      <dd className="mt-1 font-medium text-foreground">
                        {detail.skill.name}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("fields.publisher")}</dt>
                      <dd className="mt-1 font-medium text-foreground">
                        {publisherLabel(detail.skill.sourceType)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("fields.version")}</dt>
                      <dd className="mt-1 break-words font-medium text-foreground">
                        {viewedVersion?.version ?? detail.skill.version}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("fields.visibility")}</dt>
                      <dd className="mt-1 font-medium text-foreground">
                        {visibilityLabel(detail.skill.visibility)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("fields.readme")}</dt>
                      <dd className="mt-1 font-medium text-foreground">
                        {detail.skill.hasReadme ? t("fields.included") : t("fields.notIncluded")}
                      </dd>
                    </div>
                    {detail.skill.sourceType === "registry_github" &&
                    detail.skill.categories.length > 0 ? (
                      <div>
                        <dt className="text-muted-foreground">
                          {tm("detail.categories")}
                        </dt>
                        <dd className="mt-1 font-medium text-foreground">
                          {detail.skill.categories
                            .map((entry) =>
                              skillCategoryName(entry, categories),
                            )
                            .join(", ")}
                        </dd>
                      </div>
                    ) : null}
                    {formatInstallCount(detail.skill.installCount) ? (
                      <div>
                        <dt className="text-muted-foreground">
                          {tm("detail.installs")}
                        </dt>
                        <dd className="mt-1 font-medium text-foreground">
                          {formatInstallCount(detail.skill.installCount)}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <div className="mt-3 text-xs text-muted-foreground">
                    {t("detail.noSkillLoaded")}
                  </div>
                )}
              </aside>
              {detail?.skill.sourceType === "registry_github" && workspace ? (
                <SkillOwnerListing
                  catalogId={detail.skill.catalogId}
                  key={`owner-${detail.skill.skillId}-${claimRevision}`}
                  onChanged={() => void refreshDetail()}
                  workspaceId={workspace.id}
                />
              ) : null}
              {detail?.skill.sourceType === "registry_github" && workspace ? (
                <SkillClaimPanel
                  key={`claim-${detail.skill.skillId}-${claimRevision}`}
                  onChanged={() => {
                    setClaimRevision((revision) => revision + 1);
                    void refreshDetail();
                  }}
                  skillId={detail.skill.skillId}
                  workspaceId={workspace.id}
                />
              ) : null}
              {detail?.skill.sourceType === "registry_github" ? (
                <SkillMarketAdminPanel
                  categories={categories}
                  // Remounted after a claim action too, so an admin sees the
                  // standing the removal just produced without a reload.
                  key={`admin-${detail.skill.skillId}-${claimRevision}`}
                  onChanged={() => void refreshDetail()}
                  // A grant or revoke changes who holds the skill: the claim
                  // panel and the author's switch read it afresh.
                  onClaimChanged={() =>
                    setClaimRevision((revision) => revision + 1)
                  }
                  repo={claimRepoOfSourceUrl(detail.skill.sourceUrl)}
                  skillId={detail.skill.skillId}
                />
              ) : null}
              {communitySlot ? (
                <>
                  <SkillRunStats {...communitySlot} />
                  <SkillOverviewAdmin {...communitySlot} />
                  <SkillMarketEvents
                    // Remounted with the admin panel, so an action there
                    // shows up in the history at once.
                    key={`events-${communitySlot.skillId}-${claimRevision}`}
                    // A re-inference changes the standing the admin panel
                    // shows: remount it too.
                    onChanged={() => {
                      setClaimRevision((revision) => revision + 1);
                      void refreshDetail();
                    }}
                    skillId={communitySlot.skillId}
                  />
                  <SkillReportButton {...communitySlot} />
                </>
              ) : null}
            </div>
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}
