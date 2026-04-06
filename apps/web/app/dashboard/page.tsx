"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAuthenticate } from "@daveyplate/better-auth-ui";
import {
  ArrowRight,
  Building2,
  CircleCheck,
  CreditCard,
  FolderOpen,
  MessageSquareText,
  Settings2,
  Sparkles,
  Users,
} from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { authClient } from "../../lib/auth-client";
import { workspaceClient } from "../../lib/sdk";

type Organization = {
  id: string;
  name: string;
  slug?: string;
};

type Workspace = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdBy: string | null;
  createdAt: string;
};

type OverviewCardProps = {
  label: string;
  value: string;
  meta: string;
};

function parseOrganizations(payload: unknown): Organization[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is Organization =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        "name" in item,
    );
  }

  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return parseOrganizations((payload as { data: unknown }).data);
  }

  return [];
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") return value;
  }
  return "Request failed";
}

function formatRelative(value: string) {
  const time = new Date(value).getTime();
  const delta = Date.now() - time;
  const hour = 1000 * 60 * 60;
  const day = hour * 24;

  if (delta < hour) return "Updated recently";
  if (delta < day) return `${Math.max(1, Math.floor(delta / hour))}h ago`;
  return `${Math.max(1, Math.floor(delta / day))}d ago`;
}

function OverviewCard({ label, value, meta }: OverviewCardProps) {
  return (
    <article className="rounded-3xl border border-border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:shadow-none">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-4 text-3xl font-semibold tracking-tight text-foreground">
        {value}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{meta}</p>
    </article>
  );
}

function WorkspaceCard({
  workspace,
  featured = false,
}: {
  workspace: Workspace;
  featured?: boolean;
}) {
  return (
    <Link
      className={cn(
        "group rounded-3xl border border-border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-[0_10px_30px_rgba(0,0,0,0.08)] dark:hover:shadow-none",
        featured && "bg-linear-to-br from-card to-muted/30",
      )}
      href="/dashboard/chat"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="inline-flex rounded-xl border border-border bg-background px-2 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Workspace
          </div>
          <h3 className="mt-3 truncate text-lg font-semibold text-foreground">
            {workspace.name}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{workspace.slug}</p>
        </div>
        <span className="rounded-xl border border-border bg-background p-2 text-muted-foreground transition-colors group-hover:text-foreground">
          <ArrowRight className="h-4 w-4" />
        </span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-lg border border-border bg-background px-2 py-1">
          Ready for chat
        </span>
        <span className="rounded-lg border border-border bg-background px-2 py-1">
          Source-aware
        </span>
        <span>{formatRelative(workspace.createdAt)}</span>
      </div>
    </Link>
  );
}

export default function DashboardPage() {
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

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeOrg = useMemo(
    () => organizations.find((org) => org.id === activeOrgId) || null,
    [organizations, activeOrgId],
  );

  const featuredWorkspace = workspaces[0] || null;

  const overviewCards = useMemo(
    () => [
      {
        label: "Organizations",
        value: String(organizations.length),
        meta: activeOrg
          ? `Active in ${activeOrg.name}`
          : "No organization selected",
      },
      {
        label: "Workspaces",
        value: String(workspaces.length),
        meta:
          featuredWorkspace?.name ||
          "Create a workspace to start a source-driven chat flow",
      },
      {
        label: "Primary route",
        value: "Chat",
        meta: "Your notebook-style workspace is ready under /dashboard/chat",
      },
      {
        label: "Account",
        value: sessionState?.user?.email || "Signed in",
        meta: "Team, billing, and settings live alongside the chat workflow",
      },
    ],
    [
      activeOrg,
      featuredWorkspace?.name,
      organizations.length,
      sessionState?.user?.email,
      workspaces.length,
    ],
  );

  useEffect(() => {
    async function loadOverview() {
      if (!hasSession) return;

      setLoading(true);
      setError(null);

      try {
        const result = await authClient.organization.list();
        const organizationItems = parseOrganizations(result?.data ?? result);
        const nextActiveOrgId =
          sessionActiveOrganizationId || organizationItems[0]?.id || null;

        setOrganizations(organizationItems);
        setActiveOrgId(nextActiveOrgId);

        if (!nextActiveOrgId) {
          setWorkspaces([]);
          return;
        }

        const workspaceResponse =
          await workspaceClient.listWorkspaces(nextActiveOrgId);

        setWorkspaces(workspaceResponse.items);
      } catch (value) {
        setError(toErrorMessage(value));
      } finally {
        setLoading(false);
      }
    }

    void loadOverview();
  }, [hasSession, sessionActiveOrganizationId]);

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
    <main className="flex flex-1 flex-col">
      <header className="border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="flex h-16 items-center justify-between gap-3 px-4 md:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Workspace overview
            </p>
            <h1 className="text-lg font-semibold text-foreground">
              Launch your next source-aware workspace
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              href="/dashboard/team"
            >
              <Users className="h-4 w-4" />
              Team
            </Link>
            <Link
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              href="/dashboard/chat"
            >
              <MessageSquareText className="h-4 w-4" />
              Open chat workspace
            </Link>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.95fr)]">
          <article className="rounded-[28px] border border-border bg-linear-to-br from-card via-card to-muted/40 p-6 shadow-[0_12px_40px_rgba(0,0,0,0.05)] dark:shadow-none">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="max-w-2xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  SourceWeft Dashboard
                </div>
                <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
                  A cleaner launch point for research, chat, and evidence.
                </h2>
                <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
                  Start from a workspace, move into grounded chat, and keep
                  sources, team context, and billing controls in the same
                  product shell.
                </p>
              </div>

              <div className="grid min-w-[220px] gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <Link
                  className="rounded-2xl border border-border bg-background p-4 transition-colors hover:bg-accent"
                  href="/dashboard/chat"
                >
                  <div className="flex items-center justify-between gap-2">
                    <MessageSquareText className="h-4 w-4 text-foreground" />
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="mt-4 text-sm font-medium text-foreground">
                    Enter chat workspace
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Review shared and private conversations with sources docked
                    on the right.
                  </p>
                </Link>

                <Link
                  className="rounded-2xl border border-border bg-background p-4 transition-colors hover:bg-accent"
                  href="/dashboard/settings"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Settings2 className="h-4 w-4 text-foreground" />
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="mt-4 text-sm font-medium text-foreground">
                    Tune account setup
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Manage sessions, providers, keys, and security in one place.
                  </p>
                </Link>
              </div>
            </div>

            {error ? (
              <div className="mt-5 rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </article>

          <article className="rounded-[28px] border border-border bg-card p-6 shadow-[0_8px_28px_rgba(0,0,0,0.05)] dark:shadow-none">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CircleCheck className="h-4 w-4 text-emerald-500" />
              Launch checklist
            </div>
            <div className="mt-5 space-y-3">
              {[
                {
                  title: "Organization ready",
                  done: organizations.length > 0,
                  meta:
                    activeOrg?.name ||
                    "Create or select an organization in team settings.",
                },
                {
                  title: "Workspace available",
                  done: workspaces.length > 0,
                  meta:
                    featuredWorkspace?.name ||
                    "Add a workspace to route sources and chats cleanly.",
                },
                {
                  title: "Chat workspace shipped",
                  done: true,
                  meta: "Notebook-style chat now lives under /dashboard/chat.",
                },
              ].map((item) => (
                <div
                  className="rounded-2xl border border-border bg-background px-4 py-3"
                  key={item.title}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-foreground">
                      {item.title}
                    </p>
                    <span
                      className={cn(
                        "rounded-full px-2 py-1 text-[11px] font-medium",
                        item.done
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                          : "bg-secondary text-muted-foreground",
                      )}
                    >
                      {item.done ? "Done" : "Pending"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.meta}
                  </p>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {overviewCards.map((card) => (
            <OverviewCard key={card.label} {...card} />
          ))}
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.9fr)]">
          <article className="rounded-[28px] border border-border bg-card p-5 shadow-[0_8px_28px_rgba(0,0,0,0.05)] dark:shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Recent workspaces
                </p>
                <h2 className="mt-1 text-xl font-semibold text-foreground">
                  Continue from where your team left off
                </h2>
              </div>
              <Link
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                href="/dashboard/chat"
              >
                Open chat
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <div
                    className="min-h-44 rounded-3xl border border-border bg-muted/50"
                    key={index}
                  />
                ))
              ) : workspaces.length > 0 ? (
                workspaces
                  .slice(0, 4)
                  .map((workspace, index) => (
                    <WorkspaceCard
                      featured={index === 0}
                      key={workspace.id}
                      workspace={workspace}
                    />
                  ))
              ) : (
                <div className="rounded-3xl border border-dashed border-border bg-background p-6 text-sm text-muted-foreground lg:col-span-2">
                  No workspaces yet. Create one from your team settings and use
                  it as the entry point for chat, sources, and artifacts.
                </div>
              )}
            </div>
          </article>

          <div className="space-y-4">
            <article className="rounded-[28px] border border-border bg-card p-5 shadow-[0_8px_28px_rgba(0,0,0,0.05)] dark:shadow-none">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Quick paths
              </p>
              <div className="mt-4 space-y-3">
                {[
                  {
                    label: "Team configuration",
                    description:
                      "Manage organization structure, roles, and invites.",
                    href: "/dashboard/team",
                    icon: Users,
                  },
                  {
                    label: "Billing controls",
                    description:
                      "Inspect credits, usage, and subscription status.",
                    href: "/dashboard/billing",
                    icon: CreditCard,
                  },
                  {
                    label: "Account settings",
                    description:
                      "Review sessions, providers, and authentication.",
                    href: "/dashboard/settings",
                    icon: Settings2,
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      className="flex items-start gap-3 rounded-2xl border border-border bg-background p-4 transition-colors hover:bg-accent"
                      href={item.href}
                      key={item.label}
                    >
                      <span className="rounded-xl border border-border bg-card p-2 text-muted-foreground">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">
                          {item.label}
                        </span>
                        <span className="mt-1 block text-sm text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </article>

            <article className="rounded-[28px] border border-border bg-card p-5 shadow-[0_8px_28px_rgba(0,0,0,0.05)] dark:shadow-none">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                What changed
              </p>
              <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                {[
                  {
                    icon: MessageSquareText,
                    title: "Chat workspace promoted",
                    description:
                      "The notebook-style conversation view now has its own dedicated route and product shell.",
                  },
                  {
                    icon: FolderOpen,
                    title: "Sources stay close to chat",
                    description:
                      "Library, In Chat, Citations, and Connectors remain available as one right-side context hub.",
                  },
                  {
                    icon: Building2,
                    title: "Overview is now the launcher",
                    description:
                      "This page becomes the start point for workspaces, team operations, and account controls.",
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <div
                      className="rounded-2xl border border-border bg-background p-4"
                      key={item.title}
                    >
                      <div className="flex items-center gap-2 text-foreground">
                        <Icon className="h-4 w-4" />
                        <span className="text-sm font-medium">
                          {item.title}
                        </span>
                      </div>
                      <p className="mt-2 leading-6 text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </article>
          </div>
        </section>
      </div>
    </main>
  );
}
