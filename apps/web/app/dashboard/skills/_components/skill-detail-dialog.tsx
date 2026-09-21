"use client";

import { SkillAvatar } from "./skill-avatar";

import * as React from "react";
import type {
  RegistryVersionDetail,
  SkillCatalogCategory,
} from "@sourceweft/contracts";
import { RegistryVersions } from "./registry-versions";
import { SkillContentRestricted } from "./skill-content-restricted";
import { SkillIntroduction } from "./skill-introduction";
import { SkillMarketFacts } from "./skill-market-facts";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Loader2,
  RotateCw,
  Scale,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { contentClient } from "../../../../lib/sdk";
import { SkillIcon } from "../../../_components/site-icons";

type SkillCatalogItem = Awaited<
  ReturnType<typeof contentClient.listSkillsCatalog>
>["items"][number];

type SkillCatalogDetail = Awaited<
  ReturnType<typeof contentClient.getSkillCatalogDetail>
>;

export function SkillDetailDialog({
  categories,
  item,
  onInstall,
  onOpenChange,
  onUninstall,
  onVersionChanged,
  pending,
  workspaceId,
}: {
  /** The market's categories, to name the slugs a community skill carries. */
  categories?: SkillCatalogCategory[];
  item: SkillCatalogItem | null;
  onInstall: (item: SkillCatalogItem) => void;
  onOpenChange: (open: boolean) => void;
  onUninstall: (item: SkillCatalogItem) => void;
  onVersionChanged?: () => void;
  pending: boolean;
  workspaceId: string | null;
}) {
  const t = useTranslations("dashboardSkills");
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
  const [detail, setDetail] = React.useState<SkillCatalogDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const generationRef = React.useRef(0);
  const versionChangedRef = React.useRef(false);
  const [registryDetail, setRegistryDetail] =
    React.useState<RegistryVersionDetail | null>(null);
  const handleVersionView = React.useCallback(
    (value: RegistryVersionDetail | null) => setRegistryDetail(value),
    [],
  );

  React.useEffect(() => {
    const generation = ++generationRef.current;
    setRegistryDetail(null);
    if (!item || !workspaceId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    setDetail(null);
    setError(null);
    setLoading(true);
    void contentClient
      .getSkillCatalogDetail(workspaceId, item.catalogId)
      .then((result) => {
        if (generationRef.current !== generation) return;
        setDetail(result);
      })
      .catch((loadError) => {
        if (generationRef.current !== generation) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("dialog.loadFailed"),
        );
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
  }, [item, reloadKey, workspaceId, t]);

  const baseItem = detail?.skill ?? item;
  const activeItem =
    baseItem && registryDetail
      ? {
          ...baseItem,
          skillVersionId: registryDetail.version.id,
          version: registryDetail.version.version,
          catalogId: `${baseItem.skillId}:${registryDetail.version.id}`,
          description: registryDetail.version.description,
          displayName: registryDetail.version.displayName,
          installable: registryDetail.version.status === "published",
          sourceUrl: registryDetail.version.sourceUrl,
          // Withheld text still has a path: the README exists, it is just
          // not ours to show this viewer.
          hasReadme: registryDetail.contentRestricted
            ? registryDetail.readmePath !== null
            : Boolean(registryDetail.readmeContent?.trim()),
          logo: registryDetail.version.logo,
          flagged: registryDetail.version.flags.length > 0,
        }
      : baseItem;
  const installed =
    activeItem?.sourceType === "registry_github"
      ? !!activeItem.enabledWorkspaceSkillId
      : activeItem?.enabled;
  const canManageInstall =
    activeItem?.installable !== false ||
    (activeItem?.sourceType === "registry_github" && installed);
  const documents =
    item?.sourceType === "registry_github" ? registryDetail : detail;
  const skillContent = documents?.skillContent;
  const contentRestricted = documents?.contentRestricted === true;

  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open && versionChangedRef.current) {
          versionChangedRef.current = false;
          onVersionChanged?.();
        }
        onOpenChange(open);
      }}
    >
      <DialogContent
        className="grid max-h-[calc(100svh-2rem)] w-[min(1080px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b border-border px-5 py-4 pr-16 text-left">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {activeItem ? <SkillAvatar item={activeItem} /> : null}
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {activeItem?.displayName ?? t("dialog.titleFallback")}
                </DialogTitle>
                <DialogDescription className="mt-1 line-clamp-2 text-xs">
                  {activeItem?.description ?? t("dialog.descriptionLoading")}
                </DialogDescription>
                {activeItem ? (
                  <SkillMarketFacts
                    categories={categories ?? []}
                    className="mt-1.5"
                    item={activeItem}
                  />
                ) : null}
              </div>
            </div>
            {activeItem && canManageInstall ? (
              <Button
                className="mr-3 h-8 shrink-0 px-3 text-xs"
                disabled={
                  pending ||
                  (activeItem.sourceType === "registry_github" &&
                    !registryDetail)
                }
                onClick={() =>
                  installed ? onUninstall(activeItem) : onInstall(activeItem)
                }
                size="sm"
                type="button"
                variant={installed ? "secondary" : "default"}
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : installed ? (
                  <Trash2 className="size-4" />
                ) : (
                  <SkillIcon className="size-4" />
                )}
                {installed ? t("actions.uninstall") : t("actions.install")}
              </Button>
            ) : null}
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {t("loading.skill")}
            </div>
          ) : error ? (
            <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-5 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                onClick={() => setReloadKey((current) => current + 1)}
                size="sm"
                type="button"
                variant="outline"
              >
                <RotateCw className="size-4" />
                {t("actions.retry")}
              </Button>
            </div>
          ) : activeItem ? (
            <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
              <div className="flex min-w-0 flex-col gap-4">
                {item?.sourceType === "registry_github" && workspaceId ? (
                  <RegistryVersions
                    key={item.catalogId}
                    workspaceId={workspaceId}
                    catalogId={item.catalogId}
                    initialVersionId={item.skillVersionId}
                    // The catalog lists a skill under its published current
                    // version; an owner's unpublished draft is not an update.
                    currentVersionId={
                      item.installable === false ? null : item.skillVersionId
                    }
                    onView={handleVersionView}
                    onChanged={() => {
                      versionChangedRef.current = true;
                    }}
                  />
                ) : null}
                {activeItem.flagged ? (
                  <section className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {t("dialog.flaggedNotice")}
                  </section>
                ) : null}
                {activeItem.sourceType === "registry_github" &&
                !activeItem.verified ? (
                  <section className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {t("dialog.unverifiedNotice")}
                  </section>
                ) : null}
                <article className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
                  {documents ? (
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
                      {/* Immutable version documents must not share streaming block state. */}
                      <TabsContent className="m-0 px-5 py-5" value="overview">
                        {contentRestricted ? (
                          <SkillContentRestricted
                            description={activeItem.description}
                            sourceUrl={activeItem.sourceUrl}
                          />
                        ) : (
                          <SkillIntroduction
                            key={`${activeItem.skillVersionId}:overview`}
                            {...documents}
                            displayName={activeItem.displayName}
                            description={activeItem.description}
                          />
                        )}
                      </TabsContent>
                      <TabsContent className="m-0 px-5 py-5" value="skill">
                        {contentRestricted ? (
                          <SkillContentRestricted
                            sourceUrl={activeItem.sourceUrl}
                          />
                        ) : skillContent ? (
                          <MessageResponse
                            key={`${activeItem.skillVersionId}:skill`}
                            mode="static"
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
                  ) : (
                    <p className="px-5 py-10 text-sm text-muted-foreground">
                      {t("dialog.docsPending")}
                    </p>
                  )}
                </article>
              </div>

              <aside className="h-fit rounded-lg border border-border bg-background p-4">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">
                    {t("fields.heading")}
                  </h2>
                </div>
                <dl className="mt-3 space-y-3 text-xs">
                  {[
                    { label: t("fields.name"), value: activeItem.name },
                    {
                      label: t("fields.publisher"),
                      value: publisherLabel(activeItem.sourceType),
                    },
                    { label: t("fields.version"), value: activeItem.version },
                    {
                      label: t("fields.visibility"),
                      value: visibilityLabel(activeItem.visibility),
                    },
                    {
                      label: t("fields.readme"),
                      value: activeItem.hasReadme
                        ? t("fields.included")
                        : t("fields.notIncluded"),
                    },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="mt-1 break-words font-medium text-foreground">
                        {value}
                      </dd>
                    </div>
                  ))}
                  {activeItem.license ? (
                    <div>
                      <dt className="text-muted-foreground">
                        {t("fields.license")}
                      </dt>
                      <dd className="mt-1 inline-flex items-center gap-1 break-words font-medium text-foreground">
                        <Scale className="size-3 shrink-0" />
                        {activeItem.license}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {activeItem.sourceUrl ? (
                  <div className="mt-4 border-t border-border pt-3 text-xs">
                    <a
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                      href={activeItem.sourceUrl}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      <ExternalLink className="size-3" />
                      {t("actions.source")}
                    </a>
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border pt-3">
                  <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
                    {publisherLabel(activeItem.sourceType)}
                  </Badge>
                  {activeItem.sourceType === "registry_github" &&
                  !activeItem.verified ? (
                    <Badge
                      className="h-5 gap-1 px-1.5 text-[10px]"
                      variant="outline"
                    >
                      <AlertTriangle className="size-2.5" />
                      {t("status.unverified")}
                    </Badge>
                  ) : null}
                  {activeItem.flagged ? (
                    <Badge
                      className="h-5 gap-1 border-amber-500/30 px-1.5 text-[10px] text-amber-700 dark:text-amber-300"
                      variant="outline"
                    >
                      {t("status.underReview")}
                    </Badge>
                  ) : null}
                  {installed && canManageInstall ? (
                    <Badge
                      className="h-5 px-1.5 text-[10px]"
                      variant="secondary"
                    >
                      {t("status.installed")}
                    </Badge>
                  ) : null}
                  {!canManageInstall && activeItem.sourceType === "builtin" ? (
                    <Badge
                      className="h-5 px-1.5 text-[10px]"
                      variant="secondary"
                    >
                      {t("status.builtin")}
                    </Badge>
                  ) : null}
                </div>
              </aside>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
