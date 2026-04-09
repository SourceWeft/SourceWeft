"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthenticate } from "@daveyplate/better-auth-ui";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileText,
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
  isMock?: boolean;
};

type ActivityItem = {
  id: string;
  title: string;
  workspaceName: string;
  status: string;
  updatedAt: string;
};

function isoHoursAgo(hoursAgo: number) {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

const MOCK_WORKSPACES: WorkspaceWithPreview[] = [
  {
    id: "mock-market-intel",
    organizationId: "mock-personal",
    name: "Market Intel",
    slug: "market-intel",
    createdBy: null,
    createdAt: isoHoursAgo(3),
    sourceCount: 14,
    isMock: true,
    sources: [
      {
        id: "mock-source-1",
        title: "AI infra pricing benchmark Q2",
        contentText:
          "Model pricing has stabilized across the top vendors, but latency-linked markups continue to widen for enterprise plans. The clearest pattern is that teams now trade compute cost for predictability rather than raw throughput.",
        status: "indexed",
        updatedAt: isoHoursAgo(1),
      },
      {
        id: "mock-source-2",
        title: "Competitor launch notes",
        contentText:
          "The launch message centers on trust, citations, and team memory. Positioning overlaps most directly with source-grounded chat rather than generic copilots.",
        status: "indexed",
        updatedAt: isoHoursAgo(2),
      },
      {
        id: "mock-source-3",
        title: "Customer calls synthesis",
        contentText:
          "Customers consistently ask for one place where files, notes, and chat context stay together without requiring extra setup each time they start a session.",
        status: "processing",
        updatedAt: isoHoursAgo(3),
      },
    ],
  },
  {
    id: "mock-product-positioning",
    organizationId: "mock-personal",
    name: "Product Positioning",
    slug: "product-positioning",
    createdBy: null,
    createdAt: isoHoursAgo(10),
    sourceCount: 8,
    isMock: true,
    sources: [
      {
        id: "mock-source-4",
        title: "Homepage messaging draft v4",
        contentText:
          "SourceWeft keeps research, uploads, and grounded chat in the same workspace so teams can move from reading to synthesis without losing provenance.",
        status: "indexed",
        updatedAt: isoHoursAgo(4),
      },
      {
        id: "mock-source-5",
        title: "Persona pain points map",
        contentText:
          "Knowledge workers describe the current workflow as fragmented: one place for notes, another for files, another for AI, and no reliable bridge between them.",
        status: "indexed",
        updatedAt: isoHoursAgo(6),
      },
      {
        id: "mock-source-6",
        title: "Positioning teardown notes",
        contentText:
          "The strongest contrast is not intelligence level, but how quickly a product returns users to relevant context after time away.",
        status: "created",
        updatedAt: isoHoursAgo(8),
      },
    ],
  },
  {
    id: "mock-customer-calls",
    organizationId: "mock-personal",
    name: "Customer Calls",
    slug: "customer-calls",
    createdBy: null,
    createdAt: isoHoursAgo(18),
    sourceCount: 11,
    isMock: true,
    sources: [
      {
        id: "mock-source-7",
        title: "Onboarding friction interview notes",
        contentText:
          "Users want to know which workspace they should open, what changed since last time, and whether the latest materials are already indexed.",
        status: "indexed",
        updatedAt: isoHoursAgo(12),
      },
      {
        id: "mock-source-8",
        title: "Usage objections synthesis",
        contentText:
          "The most common objection is not feature depth but uncertainty around where to begin when a team returns after a few days away.",
        status: "processing",
        updatedAt: isoHoursAgo(14),
      },
      {
        id: "mock-source-9",
        title: "Enterprise buyer transcript",
        contentText:
          "Decision makers respond well to concise overviews that show active workspaces, recent source activity, and a direct path back into chat.",
        status: "indexed",
        updatedAt: isoHoursAgo(16),
      },
    ],
  },
  {
    id: "mock-design-system",
    organizationId: "mock-personal",
    name: "Design System",
    slug: "design-system",
    createdBy: null,
    createdAt: isoHoursAgo(28),
    sourceCount: 5,
    isMock: true,
    sources: [
      {
        id: "mock-source-10",
        title: "UI token audit",
        contentText:
          "Typography should feel quieter and more deliberate. Large card titles need stronger hierarchy against section headings, otherwise the page reads as noisy and unfinished.",
        status: "indexed",
        updatedAt: isoHoursAgo(16),
      },
      {
        id: "mock-source-11",
        title: "Dashboard redesign notes",
        contentText:
          "A good home page should suggest momentum: what changed, where to resume, and which workspace deserves attention first.",
        status: "indexed",
        updatedAt: isoHoursAgo(20),
      },
      {
        id: "mock-source-12",
        title: "Responsive layout checklist",
        contentText:
          "Cards should simplify as the viewport narrows. Decorative blocks are fine for exploration, but they should never compete with title and recency as the primary scan points.",
        status: "indexed",
        updatedAt: isoHoursAgo(24),
      },
    ],
  },
  {
    id: "mock-launch-notes",
    organizationId: "mock-personal",
    name: "Launch Notes",
    slug: "launch-notes",
    createdBy: null,
    createdAt: isoHoursAgo(40),
    sourceCount: 6,
    isMock: true,
    sources: [
      {
        id: "mock-source-13",
        title: "Release narrative draft",
        contentText:
          "This release focuses on reducing startup friction inside the dashboard by making workspaces legible, comparable, and easy to re-enter.",
        status: "created",
        updatedAt: isoHoursAgo(30),
      },
      {
        id: "mock-source-14",
        title: "Change log review",
        contentText:
          "The dashboard now favors recent work, trims auxiliary navigation noise, and emphasizes workspace-level context over generic product messaging.",
        status: "indexed",
        updatedAt: isoHoursAgo(34),
      },
      {
        id: "mock-source-15",
        title: "Launch FAQ v2",
        contentText:
          "What happens when there is no content yet? The answer should be a strong empty path, not a visually disruptive placeholder explanation.",
        status: "indexed",
        updatedAt: isoHoursAgo(38),
      },
    ],
  },
  {
    id: "mock-research-lab",
    organizationId: "mock-personal",
    name: "Research Lab",
    slug: "research-lab",
    createdBy: null,
    createdAt: isoHoursAgo(56),
    sourceCount: 9,
    isMock: true,
    sources: [
      {
        id: "mock-source-16",
        title: "Loneliness study summary",
        contentText:
          "People cope better with complex information when the interface shows a stable home, a visible sense of progress, and clear pathways back to recent work.",
        status: "indexed",
        updatedAt: isoHoursAgo(48),
      },
      {
        id: "mock-source-17",
        title: "Interview snippets repository",
        contentText:
          "One repeated request: let the homepage feel like a library table, not a settings page or marketing surface.",
        status: "indexed",
        updatedAt: isoHoursAgo(52),
      },
      {
        id: "mock-source-18",
        title: "Open questions backlog",
        contentText:
          "How much preview is enough? Usually a title, one meaningful excerpt, and a time marker are sufficient for a first scan.",
        status: "created",
        updatedAt: isoHoursAgo(54),
      },
    ],
  },
];

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

function getPreviewText(workspace: WorkspaceWithPreview) {
  const source =
    workspace.sources.find((item) => Boolean(item.contentText?.trim())) ??
    workspace.sources[0];

  if (!source) {
    return {
      eyebrow: "No files yet",
      excerpt: "",
      hasPreview: false,
      mode: "empty" as const,
    };
  }

  const raw = source.contentText?.replace(/\s+/g, " ").trim() ?? "";
  const hasPreview = raw.length > 0;

  return {
    eyebrow: source.title,
    excerpt: hasPreview
      ? raw.length > 180
        ? `${raw.slice(0, 180).trim()}...`
        : raw
      : "",
    hasPreview,
    mode: hasPreview ? ("preview" as const) : ("noText" as const),
  };
}

function WorkspaceCover({ workspace }: { workspace: WorkspaceWithPreview }) {
  const preview = getPreviewText(workspace);
  const emptyMode = preview.mode !== "preview";

  return (
    <div className="relative h-40 overflow-hidden rounded-[18px] border border-border/70 bg-linear-to-b from-muted/45 via-background to-background p-3">
      <div className="absolute inset-x-0 top-0 h-12 bg-linear-to-b from-white/35 to-transparent dark:from-white/5" />
      <div
        className={cn(
          "relative flex h-full flex-col rounded-[13px] border border-border/60 bg-background/92 p-3.5 dark:bg-background/85",
          emptyMode && "items-center justify-center",
        )}
      >
        <div className="truncate text-[11px] font-medium text-muted-foreground">
          {preview.eyebrow}
        </div>

        {preview.mode === "preview" ? (
          <p className="mt-2.5 line-clamp-5 text-[13px] leading-6 text-muted-foreground/95">
            {preview.excerpt}
          </p>
        ) : (
          <div className="relative mt-2 flex h-full w-full items-center justify-center">
            <div className="absolute inset-0 rounded-[10px] border border-dashed border-border/70 bg-muted/25" />
            <div className="absolute h-14 w-14 rounded-2xl bg-linear-to-b from-muted/80 to-muted/45 blur-[1px]" />
            <div className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-border/80 bg-background text-muted-foreground shadow-sm dark:shadow-none">
              {preview.mode === "noText" ? (
                <FileText className="h-4.5 w-4.5" />
              ) : (
                <Folder className="h-4.5 w-4.5" />
              )}
            </div>
          </div>
        )}
      </div>
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
      className="min-h-[246px] overflow-hidden rounded-[18px] border border-border/80 bg-card p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-[0_12px_28px_-24px_rgba(15,23,42,0.24)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 dark:hover:shadow-none"
      disabled={disabled}
      onClick={onCreate}
      type="button"
    >
      <div className="flex h-40 items-center justify-center rounded-[14px] border border-border/70 bg-linear-to-b from-muted/45 via-background to-background">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
          <Plus className="h-6 w-6" />
        </div>
      </div>

      <div className="px-1 pb-1 pt-3.5">
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
      className="min-h-[246px] overflow-hidden rounded-[18px] border border-border/80 bg-card p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-[0_12px_28px_-24px_rgba(15,23,42,0.24)] dark:hover:shadow-none"
      onClick={() => onOpen(workspace.id)}
      type="button"
    >
      <WorkspaceCover workspace={workspace} />

      <div className="px-1 pb-1 pt-3.5">
        <div className="line-clamp-1 text-base font-semibold leading-6 tracking-tight text-foreground">
          {workspace.name}
        </div>
        <div className="mt-1 text-[12.5px] text-muted-foreground">
          {formatRelative(getWorkspaceLastActivity(workspace))}
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
                sources: sources.slice(0, 3),
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
  const workspaceCollection = workspaces.length > 0 ? workspaces : MOCK_WORKSPACES;
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
    const targetWorkspace = workspaceCollection.find(
      (workspace) => workspace.id === workspaceId,
    );

    if (targetWorkspace?.isMock) {
      toast.message("Create a workspace first", {
        description:
          "Use New workspace to create a real workspace, then open it in chat.",
      });
      return;
    }

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
                <div className="flex w-max items-stretch gap-3 pb-3 pr-1">
                  {!search ? (
                    <div className="w-[292px] min-w-[292px] shrink-0">
                      <CreateWorkspaceCard
                        disabled={!canCreateWorkspace || createLoading}
                        onCreate={() => void handleCreateWorkspace()}
                      />
                    </div>
                  ) : null}

                  {filteredWorkspaces.map((workspace) => (
                    <div className="w-[292px] min-w-[292px] shrink-0" key={workspace.id}>
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
