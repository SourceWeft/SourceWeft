"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthenticate } from "@daveyplate/better-auth-ui";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderKanban,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  ScrollArea,
  ScrollBar,
} from "@sourceweft/ui-web/components/ui/scroll-area";
import { SidebarTrigger } from "@sourceweft/ui-web/components/ui/sidebar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient, workspaceClient } from "../../lib/sdk";
import { DashboardTeamSwitcher } from "./_components/dashboard-team-switcher";

type Workspace = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdBy: string | null;
  createdAt: string;
};

type Source = {
  id: string;
  title: string;
  contentText?: string;
  status: string;
  updatedAt: string;
};

type WorkspaceWithPreview = Workspace & {
  sources: Source[];
  sourceCount: number;
};

type ActivityItem = {
  id: string;
  title: string;
  workspaceName: string;
  status: string;
  updatedAt: string;
};

function formatRelative(value: string) {
  const time = new Date(value).getTime();
  const delta = Date.now() - time;
  const minute = 1000 * 60;
  const hour = minute * 60;
  const day = hour * 24;

  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.max(1, Math.floor(delta / minute))}m ago`;
  if (delta < day) return `${Math.max(1, Math.floor(delta / hour))}h ago`;
  return `${Math.max(1, Math.floor(delta / day))}d ago`;
}

function getWorkspaceLastActivity(workspace: WorkspaceWithPreview) {
  return (
    [workspace.createdAt, ...workspace.sources.map((source) => source.updatedAt)].sort(
      (left, right) => new Date(right).getTime() - new Date(left).getTime(),
    )[0] ?? workspace.createdAt
  );
}

function WorkspaceCover({ workspace }: { workspace: WorkspaceWithPreview }) {
  const visibleSources = workspace.sources.slice(0, 4);
  const extraCount = Math.max(0, workspace.sourceCount - visibleSources.length);
  const cardWidth = visibleSources.length <= 2 ? 116 : 100;
  const overlapStep = visibleSources.length <= 2 ? 50 : 32;
  const stackWidth =
    cardWidth + Math.max(0, visibleSources.length - 1) * overlapStep;

  return (
    <div className="relative h-40 w-full min-w-0 overflow-hidden rounded-[18px] bg-linear-to-b from-muted/20 to-muted/35 p-3">
      {visibleSources.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center rounded-[14px] bg-background/65 text-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Folder className="h-4.5 w-4.5" />
          </div>
          <div className="mt-2.5 text-sm font-medium text-foreground">No files yet</div>
          <div className="mt-1 max-w-36 text-xs leading-5 text-muted-foreground/85">
            Add sources to start building context.
          </div>
        </div>
      ) : (
        <div className="relative h-full min-w-0 overflow-hidden rounded-[14px]">
          <div className="pointer-events-none absolute inset-x-8 bottom-2 h-8 rounded-full bg-foreground/[0.035] blur-md" />
          {visibleSources.map((source, index) => {
            const left = `calc(50% - ${stackWidth / 2}px + ${
              index * overlapStep
            }px)`;
            const zIndex = visibleSources.length + index;

            return (
              <div
                className={cn(
                  "group/source absolute bottom-2 top-1 flex min-w-0 origin-bottom-left flex-col overflow-hidden rounded-[11px] border border-border/70 bg-background px-2.5 py-2.5 shadow-[4px_8px_16px_-14px_rgba(15,23,42,0.38)] transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-[6px_10px_18px_-14px_rgba(15,23,42,0.46)]",
                )}
                key={source.id}
                style={{ left, width: `${cardWidth}px`, zIndex }}
                title={source.title}
              >
                <div className="pointer-events-none absolute inset-y-0 right-0 w-3 bg-linear-to-l from-muted/25 to-transparent" />
                <div className="mb-2.5 h-1.5 w-8 rounded-full bg-muted" />
                <div className="min-h-0 min-w-0 flex-1">
                  <div className="line-clamp-4 break-words text-[10.5px] font-semibold leading-3.5 text-foreground">
                    {source.title}
                  </div>
                  <div className="mt-2.5 space-y-1.5">
                    <div className="h-1 rounded-full bg-muted/70" />
                    <div className="h-1 w-3/4 rounded-full bg-muted/50" />
                    <div className="h-1 w-1/2 rounded-full bg-muted/40" />
                  </div>
                </div>
              </div>
            );
          })}

          {extraCount > 0 ? (
            <div className="absolute right-3 top-3 rounded-full bg-background/90 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/60">
              +{extraCount} files
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function getStatusLabel(status: string) {
  switch (status) {
    case "indexed":
      return "Ready";
    case "processing":
      return "Indexing";
    case "created":
      return "New";
    default:
      return "Source";
  }
}

function getStatusTone(status: string) {
  switch (status) {
    case "indexed":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "processing":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "created":
      return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function sortWorkspacesByRecent(workspaces: WorkspaceWithPreview[]) {
  return [...workspaces].sort(
    (left, right) =>
      new Date(getWorkspaceLastActivity(right)).getTime() -
      new Date(getWorkspaceLastActivity(left)).getTime(),
  );
}

function buildActivityItems(workspaces: WorkspaceWithPreview[]): ActivityItem[] {
  const sourceItems = workspaces.flatMap((workspace) =>
    workspace.sources.map((source) => ({
      id: `${workspace.id}:${source.id}`,
      title: source.title,
      workspaceName: workspace.name,
      status: source.status,
      updatedAt: source.updatedAt,
    })),
  );

  return sourceItems
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )
    .slice(0, 5);
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div>
      <h2 className="text-[1.6rem] font-semibold tracking-tight text-foreground md:text-[1.75rem]">
        {title}
      </h2>
    </div>
  );
}

function OverviewPanel({
  canCreate,
  createLoading,
  featuredWorkspace,
  onCreateWorkspace,
  onOpenWorkspace,
  recentActivity,
}: {
  canCreate: boolean;
  createLoading: boolean;
  featuredWorkspace: WorkspaceWithPreview | null;
  onCreateWorkspace: () => void;
  onOpenWorkspace: (workspaceId: string) => void;
  recentActivity: ActivityItem[];
}) {
  return (
    <div className="overflow-hidden rounded-[28px] border border-border/80 bg-card">
      <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
        <div className="border-b border-border/70 px-7 py-7 lg:border-b-0 lg:border-r lg:px-8 lg:py-8">
          <div className="flex h-full flex-col justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-background text-muted-foreground shadow-sm dark:shadow-none">
              <FolderKanban className="h-7 w-7" />
            </div>

            <h1 className="mt-6 text-[1.9rem] font-semibold leading-tight tracking-tight text-foreground md:text-[2.2rem]">
              {featuredWorkspace
                ? `Resume in ${featuredWorkspace.name}`
                : "Create your first workspace"}
            </h1>

            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground md:text-base">
              {featuredWorkspace
                ? "Pick up recent sources, review the latest activity, and move back into grounded chat with the right workspace already in focus."
                : "Set up a workspace to organize sources, keep context together, and route directly into chat."}
            </p>

            <div className="mt-6 flex flex-wrap gap-2">
              {featuredWorkspace ? (
                <Button
                  className="rounded-xl"
                  onClick={() => onOpenWorkspace(featuredWorkspace.id)}
                >
                  Open workspace
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : null}

              <Button
                className="rounded-xl"
                disabled={!canCreate || createLoading}
                onClick={onCreateWorkspace}
                variant={featuredWorkspace ? "outline" : "default"}
              >
                {createLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create workspace
              </Button>
            </div>

            {featuredWorkspace ? (
              <div className="mt-7 flex flex-wrap gap-2">
                <span className="rounded-full border border-border bg-background px-3 py-1.5 text-sm text-foreground">
                  {featuredWorkspace.sourceCount} sources
                </span>
                <span className="rounded-full border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground">
                  Updated {formatRelative(getWorkspaceLastActivity(featuredWorkspace))}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="px-7 py-7 lg:px-8 lg:py-8">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border/70 pb-3 text-sm font-medium text-muted-foreground">
            <span>Activity</span>
            <span>Status</span>
          </div>

          <div className="divide-y divide-border/70">
            {recentActivity.map((item) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4"
                key={item.id}
              >
                <div className="min-w-0">
                  <div className="truncate text-[1.02rem] font-medium text-foreground">
                    {item.title}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="truncate">{item.workspaceName}</span>
                    <span>·</span>
                    <span className="whitespace-nowrap">{formatRelative(item.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex items-start">
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium",
                      getStatusTone(item.status),
                    )}
                  >
                    {getStatusLabel(item.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateWorkspaceCard({
  disabled,
  onCreate,
}: {
  disabled?: boolean;
  onCreate: () => void;
}) {
  return (
    <button
      className="min-h-[246px] w-full overflow-hidden rounded-[20px] border border-border/80 bg-card p-3 text-left transition-all duration-200 hover:border-foreground/20 hover:shadow-[0_10px_28px_-22px_rgba(15,23,42,0.26)] disabled:cursor-not-allowed disabled:opacity-60 dark:hover:shadow-none"
      disabled={disabled}
      onClick={onCreate}
      type="button"
    >
      <div className="flex h-40 items-center justify-center rounded-[18px] bg-muted/35">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
          <Plus className="h-6 w-6" />
        </div>
      </div>

      <div className="px-1.5 pb-1 pt-3.5">
        <div className="text-base font-semibold tracking-tight text-foreground">
          Create workspace
        </div>
        <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
          Start a clean space for sources and chat.
        </p>
      </div>
    </button>
  );
}

function WorkspaceCard({
  onOpen,
  workspace,
}: {
  onOpen: (workspaceId: string) => void;
  workspace: WorkspaceWithPreview;
}) {
  return (
    <button
      className="min-h-[246px] w-full overflow-hidden rounded-[20px] border border-border/80 bg-card p-3 text-left transition-all duration-200 hover:border-foreground/20 hover:shadow-[0_10px_28px_-22px_rgba(15,23,42,0.26)] dark:hover:shadow-none"
      onClick={() => onOpen(workspace.id)}
      type="button"
    >
      <WorkspaceCover workspace={workspace} />

        <div className="flex items-start justify-between gap-3 px-1.5 pb-1 pt-3.5">
        <div className="min-w-0">
          <div className="line-clamp-1 text-base font-semibold leading-6 tracking-tight text-foreground">
            {workspace.name}
          </div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">
            Updated {formatRelative(getWorkspaceLastActivity(workspace))}
          </div>
        </div>
        <div className="shrink-0 rounded-full bg-muted/70 px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {workspace.sourceCount} files
        </div>
      </div>
    </button>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const authState = useAuthenticate();
  const sessionState = authState.data as
    | {
        user?: { email?: string; name?: string };
        session?: { activeOrganizationId?: string | null };
      }
    | null
    | undefined;

  const hasSession = Boolean(sessionState);
  const sessionActiveOrganizationId =
    sessionState?.session?.activeOrganizationId || null;

  const [workspaces, setWorkspaces] = useState<WorkspaceWithPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [createLoading, setCreateLoading] = useState(false);

  useEffect(() => {
    async function loadWorkspaces() {
      if (!sessionActiveOrganizationId) {
        setWorkspaces([]);
        setLoading(false);
        return;
      }

      setLoading(true);

      try {
        const workspaceResponse = await workspaceClient.listWorkspaces(
          sessionActiveOrganizationId,
        );

        const withPreviews = await Promise.all(
          workspaceResponse.items.map(async (workspace: Workspace) => {
            try {
              const sourceResponse = await contentClient.listSources(workspace.id);
              const sources: Source[] = (sourceResponse.items ?? []).map(
                (source: {
                  id: string;
                  title?: string;
                  contentText?: string;
                  status?: string;
                  updatedAt?: string;
                }) => ({
                  id: source.id,
                  title: source.title ?? "Untitled",
                  contentText: source.contentText ?? source.title ?? "",
                  status: source.status ?? "created",
                  updatedAt: source.updatedAt ?? workspace.createdAt,
                }),
              );

              return {
                ...workspace,
                sourceCount: sourceResponse.items?.length ?? 0,
                sources: sources.slice(0, 4),
              };
            } catch {
              return {
                ...workspace,
                sourceCount: 0,
                sources: [],
              };
            }
          }),
        );

        setWorkspaces(withPreviews);
      } catch {
        toast.error("Failed to load workspaces.");
      } finally {
        setLoading(false);
      }
    }

    if (hasSession) {
      void loadWorkspaces();
    }
  }, [hasSession, sessionActiveOrganizationId]);

  const canCreateWorkspace = Boolean(sessionActiveOrganizationId);
  const workspaceCollection = workspaces;
  const recentWorkspaces = useMemo(
    () => sortWorkspacesByRecent(workspaceCollection),
    [workspaceCollection],
  );

  const filteredWorkspaces = useMemo(() => {
    if (!search.trim()) {
      return recentWorkspaces;
    }

    const query = search.toLowerCase();

    return recentWorkspaces.filter(
      (workspace) =>
        workspace.name.toLowerCase().includes(query) ||
        workspace.slug.toLowerCase().includes(query) ||
        workspace.sources.some((source) =>
          source.title.toLowerCase().includes(query),
        ),
    );
  }, [recentWorkspaces, search]);

  const featuredWorkspace = recentWorkspaces[0] ?? null;
  const recentActivity = useMemo(
    () => buildActivityItems(workspaceCollection),
    [workspaceCollection],
  );
  const recentScrollRef = useRef<HTMLDivElement>(null);

  function scrollRecent(direction: "prev" | "next") {
    const viewport = recentScrollRef.current?.querySelector<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]',
    );

    if (!viewport) return;

    const step = Math.max(260, Math.floor(viewport.clientWidth * 0.78));
    const left = direction === "next" ? step : -step;
    viewport.scrollBy({ left, behavior: "smooth" });
  }

  function handleRecentWheel(event: React.WheelEvent<HTMLDivElement>) {
    const viewport = recentScrollRef.current?.querySelector<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]',
    );

    if (!viewport) return;

    const horizontalDelta =
      Math.abs(event.deltaX) > 0 || event.shiftKey ? event.deltaX || event.deltaY : 0;
    const mappedDelta =
      horizontalDelta !== 0 || Math.abs(event.deltaY) < Math.abs(event.deltaX)
        ? horizontalDelta
        : event.deltaY;

    if (mappedDelta === 0) return;

    const maxLeft = viewport.scrollWidth - viewport.clientWidth;
    const atStart = viewport.scrollLeft <= 0;
    const atEnd = viewport.scrollLeft >= maxLeft - 1;
    const movingRight = mappedDelta > 0;
    const canConsume = movingRight ? !atEnd : !atStart;

    if (!canConsume) return;

    event.preventDefault();
    viewport.scrollLeft += mappedDelta;
  }

  async function handleCreateWorkspace() {
    if (!sessionActiveOrganizationId) {
      toast.error("No active team selected.");
      return;
    }

    setCreateLoading(true);

    try {
      const name = `Workspace ${workspaces.length + 1}`;
      const workspace = await workspaceClient.createWorkspace(
        sessionActiveOrganizationId,
        { name },
      );

      toast.success(`Created "${workspace.name}"`);
      await workspaceClient.setWorkspaceContext(workspace.id);
      router.push("/dashboard/chat");
    } catch {
      toast.error("Failed to create workspace.");
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleOpenWorkspace(workspaceId: string) {
    try {
      await workspaceClient.setWorkspaceContext(workspaceId);
    } catch {
      // Keep navigation forgiving even if context persistence fails.
    }

    router.push("/dashboard/chat");
  }

  if (authState.isPending) {
    return (
      <main className="flex min-h-svh items-center justify-center p-8 text-sm text-muted-foreground">
        Loading dashboard...
      </main>
    );
  }

  if (!sessionState) {
    return (
      <main className="flex min-h-svh items-center justify-center p-8 text-sm text-muted-foreground">
        Unable to resolve session.
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/20">
      <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
        <div className="flex h-16 items-center justify-between gap-3 px-4 md:px-6 xl:px-8">
          <div className="flex items-center gap-3">
            <SidebarTrigger />
            <div className="hidden h-5 w-px bg-border md:block" />
            <DashboardTeamSwitcher onAddTeam={() => router.push("/dashboard/settings")} />
          </div>

          <div className="flex flex-1 items-center justify-end gap-2 md:gap-3">
            <div className="relative min-w-0 w-full max-w-56 md:max-w-72">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
                <Search className="h-4 w-4" />
              </div>
              <Input
                className="h-10 rounded-xl pl-10 pr-3 text-sm"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search workspaces..."
                value={search}
              />
            </div>

            <Button
              className="h-10 rounded-xl px-4 text-sm"
              disabled={createLoading || !canCreateWorkspace}
              onClick={() => void handleCreateWorkspace()}
              size="sm"
            >
              {createLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              <span className="hidden md:inline">New workspace</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-9 p-4 pb-10 md:p-6 md:pb-12 xl:p-8 xl:pb-16">
          <section className="space-y-4">
            <SectionTitle title="Home" />

            {loading ? (
              <div className="flex min-h-[340px] items-center justify-center rounded-[28px] border border-border/80 bg-card">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <OverviewPanel
                canCreate={canCreateWorkspace}
                createLoading={createLoading}
                featuredWorkspace={featuredWorkspace}
                onCreateWorkspace={() => void handleCreateWorkspace()}
                onOpenWorkspace={(workspaceId) => void handleOpenWorkspace(workspaceId)}
                recentActivity={recentActivity}
              />
            )}
          </section>

          <section className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <SectionTitle title={search ? "Search results" : "Recent workspaces"} />

              <div className="flex items-center gap-2">
                <Button
                  aria-label="Scroll recent workspaces left"
                  className="h-8 w-8 rounded-full"
                  onClick={() => scrollRecent("prev")}
                  size="icon"
                  variant="outline"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  aria-label="Scroll recent workspaces right"
                  className="h-8 w-8 rounded-full"
                  onClick={() => scrollRecent("next")}
                  size="icon"
                  variant="outline"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {filteredWorkspaces.length === 0 ? (
              <div className="flex min-h-[240px] flex-col items-center justify-center gap-4 rounded-[28px] border border-dashed border-border/80 bg-card px-6 py-12 text-center">
                <div className="rounded-full border border-border bg-background p-4 text-muted-foreground">
                  <Search className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-base font-medium text-foreground">
                    No workspaces match your search
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Try a different term, or clear the search to browse recent workspaces again.
                  </p>
                </div>
              </div>
            ) : (
              <div onWheel={handleRecentWheel} ref={recentScrollRef}>
                <ScrollArea className="w-full">
                <div className="flex min-w-0 items-stretch gap-3 pb-3 pr-1">
                  {!search ? (
                    <div className="w-[292px] shrink-0">
                      <CreateWorkspaceCard
                        disabled={!canCreateWorkspace || createLoading}
                        onCreate={() => void handleCreateWorkspace()}
                      />
                    </div>
                  ) : null}

                  {filteredWorkspaces.map((workspace) => (
                    <div className="w-[292px] shrink-0" key={workspace.id}>
                      <WorkspaceCard
                        onOpen={(workspaceId) => void handleOpenWorkspace(workspaceId)}
                        workspace={workspace}
                      />
                    </div>
                  ))}
                </div>
                  <ScrollBar className="hidden" orientation="horizontal" />
                </ScrollArea>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
