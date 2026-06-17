"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sourceweft/ui-web/components/ui/tabs";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient, workspaceClient } from "../../../../lib/sdk";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { SkillIcon } from "../../_components/dashboard-icons";

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

function publisherLabel(sourceType: SkillCatalogItem["sourceType"]) {
  if (sourceType === "builtin") return "Official";
  if (sourceType === "team_custom") return "Team";
  return "Workspace";
}

function visibilityLabel(visibility: SkillCatalogItem["visibility"]) {
  return visibility.charAt(0).toUpperCase() + visibility.slice(1);
}

function readmeFallback(item: SkillCatalogItem) {
  return [
    `# ${item.displayName}`,
    "",
    item.description,
  ].join("\n");
}

function SkillAvatar({ item }: { item: SkillCatalogItem }) {
  const palette =
    item.sourceType === "builtin"
      ? "from-sky-500/90 via-cyan-500/80 to-emerald-500/85"
      : "from-violet-500/90 via-fuchsia-500/80 to-rose-500/80";

  return (
    <span
      className={cn(
        "relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-linear-to-br text-white shadow-sm",
        palette,
      )}
    >
      <span className="absolute inset-0 bg-black/10" />
      <SkillIcon className="relative h-5 w-5 drop-shadow" />
    </span>
  );
}

export default function SkillDetailPage() {
  const params = useParams<{ slug?: string | string[] }>();
  const rawSlug = Array.isArray(params.slug)
    ? params.slug[0]
    : params.slug;
  const slug = rawSlug ? safeDecode(rawSlug) : null;
  const dashboardState = useDashboardChatState();
  const [workspace, setWorkspace] = React.useState<ResolvedWorkspace | null>(null);
  const [detail, setDetail] = React.useState<SkillCatalogDetail | null>(null);
  const [isResolvingWorkspace, setIsResolvingWorkspace] = React.useState(true);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [isUninstalling, setIsUninstalling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const detailGenerationRef = React.useRef(0);

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
        setError("Skill slug is missing.");
        return;
      }

      setIsLoading(true);
      const catalog = await contentClient.listSkillsCatalog(resolved.id);
      if (detailGenerationRef.current !== generation) {
        return;
      }
      const skill = catalog.items.find((item) => item.slug === slug);
      if (!skill) {
        setDetail(null);
        setError("Skill was not found.");
        return;
      }

      const result = await contentClient.getSkillCatalogDetail(resolved.id, skill.catalogId);
      if (detailGenerationRef.current !== generation) {
        return;
      }
      setDetail(result);
    } catch (loadError) {
      if (detailGenerationRef.current !== generation) {
        return;
      }
      setDetail(null);
      setError(loadError instanceof Error ? loadError.message : "Failed to load skill.");
    } finally {
      if (detailGenerationRef.current === generation) {
        setIsResolvingWorkspace(false);
        setIsLoading(false);
      }
    }
  }, [resolveWorkspace, slug]);

  React.useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  async function installSkill() {
    if (!workspace || !detail || detail.skill.enabled) return;

    setIsInstalling(true);
    try {
      const item = detail.skill;
      const result = await contentClient.enableWorkspaceSkill(workspace.id, {
        skillId: item.skillId,
        skillVersionId: item.skillVersionId,
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
      toast.success("Skill installed");
    } catch (installError) {
      toast.error(installError instanceof Error ? installError.message : "Failed to install skill.");
    } finally {
      setIsInstalling(false);
    }
  }

  async function uninstallSkill() {
    if (!workspace || !detail || !detail.skill.enabled) return;
    if (!detail.skill.enabledWorkspaceSkillId) {
      toast.error("Skill install record is missing. Refresh and try again.");
      return;
    }

    setIsUninstalling(true);
    try {
      await contentClient.deleteWorkspaceSkill(workspace.id, detail.skill.enabledWorkspaceSkillId);
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
      toast.success("Skill uninstalled");
    } catch (uninstallError) {
      toast.error(uninstallError instanceof Error ? uninstallError.message : "Failed to uninstall skill.");
    } finally {
      setIsUninstalling(false);
    }
  }

  const pageLoading = isResolvingWorkspace || isLoading;
  const readmeContent = detail
    ? detail.readmeContent ?? readmeFallback(detail.skill)
    : "";
  const skillContent = detail?.skillContent ?? "";
  const canManageInstall = detail?.skill.installable !== false;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button asChild aria-label="Back to skills" className="h-8 w-8 rounded-full p-0" size="icon-sm" type="button" variant="ghost">
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
                      <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
                        {publisherLabel(detail.skill.sourceType)}
                      </Badge>
                      {detail.skill.enabled && canManageInstall ? (
                        <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
                          Installed
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </>
              ) : (
                <div className="min-w-0">
                  <h1 className="truncate text-base font-semibold text-foreground">Skill details</h1>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {detail && canManageInstall ? (
                <Button
                  className="h-8 px-3 text-xs"
                  disabled={isInstalling || isUninstalling}
                  onClick={() => void (detail.skill.enabled ? uninstallSkill() : installSkill())}
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
                  {detail.skill.enabled ? "Uninstall" : "Install"}
                </Button>
              ) : null}
            </div>
          </div>

          {error ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-300">{error}</p>
          ) : null}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <article className="min-w-0 rounded-2xl border border-border bg-background shadow-xs">
              {pageLoading ? (
                <div className="flex items-center justify-center px-5 py-16 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading skill...
                </div>
              ) : error ? (
                <div className="px-5 py-10 text-sm text-destructive">
                  {error}
                </div>
              ) : (
                <Tabs className="gap-0" defaultValue="readme">
                  <div className="border-b border-border px-5 py-3">
                    <TabsList className="h-8" variant="line">
                      <TabsTrigger className="px-2.5 text-xs" value="readme">
                        README
                      </TabsTrigger>
                      <TabsTrigger className="px-2.5 text-xs" value="skill">
                        SKILL.md
                      </TabsTrigger>
                    </TabsList>
                  </div>
                  <TabsContent className="m-0 px-5 py-5" value="readme">
                    <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                      {readmeContent}
                    </MessageResponse>
                  </TabsContent>
                  <TabsContent className="m-0 px-5 py-5" value="skill">
                    {skillContent ? (
                      <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                        {skillContent}
                      </MessageResponse>
                    ) : (
                      <div className="py-10 text-sm text-muted-foreground">
                        This skill does not include SKILL.md content.
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              )}
            </article>

            <aside className="h-fit rounded-2xl border border-border bg-background p-4 shadow-xs">
              <h2 className="text-sm font-semibold text-foreground">Details</h2>
              {detail ? (
                <dl className="mt-3 space-y-3 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Name</dt>
                    <dd className="mt-1 font-medium text-foreground">{detail.skill.name}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Publisher</dt>
                    <dd className="mt-1 font-medium text-foreground">{publisherLabel(detail.skill.sourceType)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Version</dt>
                    <dd className="mt-1 font-medium text-foreground">{detail.skill.version}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Visibility</dt>
                    <dd className="mt-1 font-medium text-foreground">{visibilityLabel(detail.skill.visibility)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">README</dt>
                    <dd className="mt-1 font-medium text-foreground">{detail.skill.hasReadme ? "Included" : "Not included"}</dd>
                  </div>
                </dl>
              ) : (
                <div className="mt-3 text-xs text-muted-foreground">
                  No skill loaded.
                </div>
              )}
            </aside>
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}
