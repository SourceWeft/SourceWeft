import type { ReactNode } from "react";
import {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
} from "@sourceweft/ui-web/components/ui/card";
import { ChatHeaderSkeleton } from "./chat-header-skeleton";
import { CatalogRouteSkeleton } from "./catalog-loading-skeleton";
import { TraceListSkeletonRows } from "../dashboard/observability/trace-loading-skeleton";

type SkeletonProps = {
  className?: string;
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function SkeletonBlock({ className }: SkeletonProps) {
  return (
    <div
      className={cx(
        "max-w-full animate-pulse rounded-md bg-muted/80",
        className,
      )}
    />
  );
}

function SkeletonLine({ className }: SkeletonProps) {
  return <SkeletonBlock className={cx("h-3", className)} />;
}

function ChatSoftBlock({ className }: SkeletonProps) {
  return <div className={cx("rounded-md bg-muted/60", className)} />;
}

function ChatSoftLine({ className }: SkeletonProps) {
  return <ChatSoftBlock className={cx("h-2.5 rounded-full", className)} />;
}

function DashboardFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background text-foreground">
      <section className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
      </section>
    </div>
  );
}

function isChatRoute(pathname?: string | null) {
  return Boolean(pathname?.startsWith("/dashboard/chat"));
}

function isChatIndexRoute(pathname?: string | null) {
  return pathname?.replace(/\/+$/, "") === "/dashboard/chat";
}

function isSkillDetailRoute(pathname?: string | null) {
  if (!pathname) {
    return false;
  }
  const normalized = pathname.replace(/\/+$/, "");
  return (
    normalized.startsWith("/dashboard/skills/") &&
    normalized !== "/dashboard/skills"
  );
}

function isSkillsListRoute(pathname?: string | null) {
  return pathname?.replace(/\/+$/, "") === "/dashboard/skills";
}

export function DashboardSkeletonContentForPath({
  pathname,
}: {
  pathname?: string | null;
}) {
  if (!pathname) {
    return <DashboardDeferredContent />;
  }
  if (isChatIndexRoute(pathname)) {
    return <ChatSkeletonContent variant="new" />;
  }
  if (isChatRoute(pathname)) {
    return <ChatSkeletonContent variant="thread" />;
  }
  if (pathname?.startsWith("/dashboard/observability")) {
    return <ObservabilitySkeletonContent />;
  }
  if (pathname === "/dashboard/skills/claim")
    return <DashboardDeferredContent />;
  if (pathname === "/dashboard/hub-window")
    return <SourcesHubPanelSkeleton variant="drawer" />;
  if (pathname === "/dashboard/preview-window")
    return <ArtifactPreviewPanelSkeleton />;
  if (isSkillDetailRoute(pathname)) {
    return <SkillDetailSkeletonContent />;
  }
  if (isSkillsListRoute(pathname)) {
    return <CatalogRouteSkeleton kind="skills" />;
  }
  if (pathname.replace(/\/+$/, "") === "/dashboard/mcp")
    return <CatalogRouteSkeleton kind="mcp" />;
  if (pathname.startsWith("/dashboard/mcp/"))
    return <SkillDetailSkeletonContent kind="mcp" />;
  if (pathname.startsWith("/dashboard/billing")) {
    return (
      <BillingSkeletonContent
        checkout={pathname.startsWith("/dashboard/billing/checkout")}
      />
    );
  }
  if (pathname.replace(/\/+$/, "") === "/dashboard")
    return <DashboardHomeSkeletonContent />;
  return <DashboardDeferredContent />;
}

export function DashboardSidebarSkeleton({
  brand,
  desktopTitlebar = false,
  width = 280,
  collapsed = false,
}: {
  brand: ReactNode;
  desktopTitlebar?: boolean;
  width?: number;
  collapsed?: boolean;
}) {
  if (collapsed) {
    return (
      <aside
        style={{ width }}
        className="flex h-svh shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar px-2 py-3"
      >
        {brand}
        <div className="space-y-2">
          {Array.from({ length: 7 }, (_, index) => (
            <SkeletonBlock key={index} className="size-9 rounded-lg" />
          ))}
        </div>
        <SkeletonBlock className="mt-auto size-9 rounded-full" />
      </aside>
    );
  }

  return (
    <aside
      style={{ width }}
      className="flex h-svh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <div className="shrink-0 px-3">
        {brand}
        {desktopTitlebar && (
          <div data-desktop-drag-region="" className="h-10 shrink-0" />
        )}
        <div className="flex h-12 items-center gap-2 sm:h-14">
          <SkeletonBlock className="h-8 flex-1 rounded-lg" />
          <SkeletonBlock className="size-8" />
        </div>
        <div className="flex h-9 items-center gap-2 px-3">
          <SkeletonBlock className="size-4" />
          <SkeletonLine className="w-24" />
        </div>
      </div>
      <div className="shrink-0 border-b border-sidebar-border/60 px-3 pb-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex h-9 items-center gap-2 px-3">
            <SkeletonBlock className="size-4" />
            <SkeletonLine className="w-24" />
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-hidden px-3 py-4">
        <SkeletonLine className="w-16" />
        {Array.from({ length: 6 }, (_, index) => (
          <SkeletonLine key={index} className="w-44" />
        ))}
      </div>
      <div className="shrink-0 border-t border-sidebar-border/60 p-3">
        <SkeletonBlock className="h-10 rounded-lg" />
      </div>
    </aside>
  );
}

export function DashboardMobileBottomNavSkeleton() {
  return (
    <nav className="absolute inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 md:hidden">
      <div className="grid grid-cols-5 gap-1">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            className="flex h-11 flex-col items-center justify-center gap-1"
            key={index}
          >
            <SkeletonBlock className="size-5 rounded-md" />
            <SkeletonLine className="w-9" />
          </div>
        ))}
      </div>
    </nav>
  );
}

function DashboardDeferredContent() {
  return <main className="h-full min-h-0 overflow-hidden bg-card" />;
}

export function DashboardContentRouteSkeleton({
  children,
}: {
  children: ReactNode;
}) {
  return <div className="min-h-0 flex-1">{children}</div>;
}

function DashboardHomeHeaderSkeleton() {
  return (
    <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
      <div className="flex min-h-16 items-center justify-between gap-2 px-3 py-2 md:h-16 md:gap-3 md:px-6 md:py-0 xl:px-8">
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <SkeletonBlock className="h-9 w-36 max-w-[48vw] rounded-xl md:w-48" />
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 md:gap-3">
          <SkeletonBlock className="h-10 w-full max-w-[42vw] rounded-xl md:max-w-72" />
        </div>
      </div>
    </header>
  );
}

export function DashboardHomeOverviewPanelSkeleton() {
  return (
    <div className="overflow-hidden rounded-[28px] border border-border/80 bg-card lg:min-h-[430px]">
      <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
        <div className="border-b border-border/70 px-7 py-7 lg:border-b-0 lg:border-r lg:px-8 lg:py-8">
          <div className="flex h-full flex-col justify-center">
            <SkeletonBlock className="h-14 w-14 rounded-2xl border border-border bg-background" />

            <div className="mt-6 space-y-3">
              <SkeletonLine className="h-8 w-3/4 max-w-xl md:h-9" />
              <SkeletonLine className="h-8 w-1/2 max-w-md md:h-9" />
            </div>

            <div className="mt-4 max-w-2xl space-y-2.5">
              <SkeletonLine className="h-4 w-full" />
              <SkeletonLine className="h-4 w-5/6" />
              <SkeletonLine className="h-4 w-2/3" />
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <SkeletonBlock className="h-10 w-36 rounded-xl" />
              <SkeletonBlock className="h-10 w-40 rounded-xl" />
            </div>

            <div className="mt-7 flex flex-wrap gap-2">
              <SkeletonBlock className="h-8 w-24 rounded-full border border-border bg-background" />
              <SkeletonBlock className="h-8 w-32 rounded-full border border-border bg-background" />
            </div>
          </div>
        </div>

        <div className="px-7 py-7 lg:px-8 lg:py-8">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border/70 pb-3">
            <SkeletonLine className="h-4 w-16" />
            <SkeletonLine className="h-4 w-10" />
          </div>

          <div className="divide-y divide-border/70">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4"
                key={index}
              >
                <div className="min-w-0 space-y-2">
                  <SkeletonLine
                    className={index % 2 ? "h-4 w-48" : "h-4 w-64 max-w-full"}
                  />
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <SkeletonLine className="w-16" />
                    <SkeletonLine className="w-28" />
                    <SkeletonLine className="w-12" />
                  </div>
                </div>
                <SkeletonBlock className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardHomeWorkspaceCardSkeleton({ create }: { create?: boolean }) {
  return (
    <div className="min-h-[246px] w-full overflow-hidden rounded-[20px] border border-border/80 bg-card p-3">
      <div className="relative h-40 w-full min-w-0 overflow-hidden rounded-[18px] bg-muted/35 p-3">
        {create ? (
          <div className="flex h-full items-center justify-center rounded-[18px]">
            <SkeletonBlock className="h-11 w-11 rounded-lg border border-border bg-background" />
          </div>
        ) : (
          <div className="flex h-full items-end justify-center overflow-hidden rounded-[14px]">
            <div className="flex h-[124px] items-end">
              {Array.from({ length: 3 }).map((_, index) => (
                <div
                  className={cx(
                    "flex h-full w-[100px] flex-col rounded-[11px] border border-border/70 bg-background px-2.5 py-2.5 shadow-[4px_8px_16px_-14px_rgba(15,23,42,0.38)]",
                    index !== 0 && "-ml-16",
                    index === 1 && "-translate-y-1",
                    index === 2 && "-translate-y-2",
                  )}
                  key={index}
                >
                  <SkeletonBlock className="mb-3 h-1.5 w-8 rounded-full" />
                  <div className="min-h-0 flex-1 space-y-2">
                    <SkeletonLine className="h-2.5 w-full" />
                    <SkeletonLine className="h-2.5 w-5/6" />
                    <SkeletonLine className="h-2.5 w-2/3" />
                  </div>
                  <div className="space-y-1.5">
                    <SkeletonBlock className="h-1 rounded-full" />
                    <SkeletonBlock className="h-1 w-3/4 rounded-full" />
                    <SkeletonBlock className="h-1 w-1/2 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-start justify-between gap-3 px-1.5 pb-1 pt-3.5">
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonLine className="h-4 w-36" />
          <SkeletonLine className="w-24" />
        </div>
        {!create ? (
          <SkeletonBlock className="h-6 w-16 shrink-0 rounded-full" />
        ) : null}
      </div>
    </div>
  );
}

export function DashboardHomeWorkspaceRailSkeleton({
  includeCreate = false,
}: {
  includeCreate?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-stretch gap-3 pb-3 md:flex-nowrap md:pr-1">
      {includeCreate ? (
        <div className="hidden w-[292px] shrink-0 md:block">
          <DashboardHomeWorkspaceCardSkeleton create />
        </div>
      ) : null}

      {Array.from({ length: includeCreate ? 4 : 3 }).map((_, index) => (
        <div className="max-md:w-full md:w-[292px] md:shrink-0" key={index}>
          <DashboardHomeWorkspaceCardSkeleton />
        </div>
      ))}
    </div>
  );
}

function DashboardHomeSkeletonContent() {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/20">
      <DashboardHomeHeaderSkeleton />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-9 p-4 pb-10 md:p-6 md:pb-12 xl:p-8 xl:pb-16">
          <section className="hidden space-y-4 md:block">
            <SkeletonLine className="h-8 w-20" />
            <DashboardHomeOverviewPanelSkeleton />
          </section>

          <section className="flex flex-col gap-4">
            <div className="hidden items-center justify-between gap-3 md:flex">
              <SkeletonLine className="h-8 w-56" />
              <div className="hidden items-center gap-2 md:flex">
                <SkeletonBlock className="h-8 w-8 rounded-full" />
                <SkeletonBlock className="h-8 w-8 rounded-full" />
              </div>
            </div>

            <DashboardHomeWorkspaceRailSkeleton />
          </section>
        </div>
      </div>
    </main>
  );
}

function ChatCanvasThreadSkeletonContent() {
  const rows = [
    { role: "user", widths: ["w-56 max-w-[58vw]", "w-36 max-w-[42vw]"] },
    { role: "assistant", widths: ["w-56", "w-80 max-w-[70vw]"] },
    {
      role: "assistant",
      widths: ["w-72 max-w-[68vw]", "w-44"],
    },
  ] as const;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background [scrollbar-gutter:stable]">
      <div className="h-full min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="px-6 py-8">
          <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-4">
            {rows.map((row, index) => (
              <div
                className={cx(
                  "flex w-full",
                  row.role === "user" ? "justify-end" : "justify-start",
                )}
                key={index}
              >
                <div
                  className={cx(
                    "flex flex-col",
                    row.role === "user"
                      ? "max-w-[86%] items-end gap-1.5"
                      : "max-w-[95%] items-start gap-2",
                  )}
                >
                  {row.widths.map((width, lineIndex) => (
                    <ChatSoftLine
                      className={cx(
                        lineIndex === 0 ? "h-3.5" : "h-3",
                        width,
                        row.role === "user" && "bg-secondary",
                      )}
                      key={lineIndex}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <ChatComposerSkeleton />
    </section>
  );
}

function ChatComposerSkeleton() {
  return (
    <div className="shrink-0 border-t border-border/60 bg-background/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
        <div className="relative flex h-auto w-full min-w-0 flex-col items-center rounded-lg border border-input outline-none">
          <div className="min-h-14 w-full px-3 py-2">
            <ChatSoftLine className="h-3.5 w-3/5 max-w-md" />
          </div>
          <div className="flex w-full items-center justify-between gap-1 px-2.5 pb-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <ChatSoftBlock className="size-8 rounded-full" />
              <ChatSoftBlock className="h-8 w-20 rounded-full" />
            </div>
            <ChatSoftBlock className="size-8 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatCanvasNewSkeletonContent() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-6 sm:px-6">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <ChatSoftLine className="h-8 w-3/4 max-w-2xl sm:h-9" />
          <div className="max-w-2xl space-y-2">
            <ChatSoftLine className="h-4 w-full" />
            <ChatSoftLine className="h-4 w-2/3" />
          </div>
          <div className="flex w-full flex-wrap gap-2 pt-2">
            {Array.from({ length: 4 }, (_, index) => (
              <ChatSoftBlock
                key={index}
                className="h-10 w-52 max-w-full rounded-full"
              />
            ))}
          </div>
        </div>
      </div>
      <ChatComposerSkeleton />
    </section>
  );
}

function ChatCanvasSkeletonContent({
  variant = "thread",
}: {
  variant?: "new" | "thread";
}) {
  return variant === "new" ? (
    <ChatCanvasNewSkeletonContent />
  ) : (
    <ChatCanvasThreadSkeletonContent />
  );
}

function SourcesHubSkeletonContent({
  className,
  variant = "panel",
}: {
  className?: string;
  variant?: "panel" | "drawer";
}) {
  return (
    <aside
      className={cx(
        "h-full shrink-0 flex-col overflow-x-hidden bg-card",
        className ??
          (variant === "drawer"
            ? "flex w-full min-w-0"
            : // Mirrors resolveWorkspaceLayout: the hub docks only in the wide
              // layout; narrower windows open it as a drawer instead.
              "hidden w-[360px] border-l min-[1440px]:flex"),
      )}
    >
      <div className="min-w-0 shrink-0 border-b px-3 py-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <SkeletonLine className="h-4 w-12" />
          <div className="flex shrink-0 gap-1.5">
            <SkeletonBlock className="size-7 rounded-md" />
            {variant === "drawer" ? (
              <SkeletonBlock className="size-7 rounded-md" />
            ) : null}
          </div>
        </div>
        <SkeletonBlock className="mt-2 h-8 rounded-xl" />
        <div className="mt-2 flex max-w-full gap-1 overflow-hidden border-t pt-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <SkeletonBlock className="h-7 w-20 rounded-lg" key={index} />
          ))}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-hidden px-3 py-3">
        {Array.from({ length: 1 }).map((_, sectionIndex) => (
          <section className="space-y-2" key={sectionIndex}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <SkeletonLine className="w-20" />
                <SkeletonLine className="w-10" />
              </div>
              <div className="flex gap-1.5">
                <SkeletonBlock className="size-7 rounded-md" />
                <SkeletonBlock className="size-7 rounded-md" />
              </div>
            </div>
            {Array.from({ length: sectionIndex === 0 ? 5 : 2 }).map(
              (_, rowIndex) => (
                <div
                  className="flex items-start gap-2 rounded-md px-2 py-1.5"
                  key={rowIndex}
                >
                  <SkeletonBlock className="size-5 shrink-0 rounded-md" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <SkeletonLine className={rowIndex % 2 ? "w-36" : "w-48"} />
                    <SkeletonLine className="w-20" />
                  </div>
                </div>
              ),
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}

export function ChatCanvasPanelSkeleton({
  variant = "thread",
}: {
  variant?: "new" | "thread";
}) {
  return <ChatCanvasSkeletonContent variant={variant} />;
}

export function ChatThreadPagePanelSkeleton() {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ChatHeaderSkeleton />
      <ChatCanvasSkeletonContent variant="thread" />
    </div>
  );
}

export function ArtifactPreviewPanelSkeleton() {
  return (
    <section className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l bg-background">
      <div className="shrink-0 space-y-3 border-b bg-muted/20 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <SkeletonBlock className="h-7 w-16" />
          <div className="flex gap-1">
            {Array.from({ length: 3 }, (_, index) => (
              <SkeletonBlock key={index} className="size-7" />
            ))}
          </div>
        </div>
        <SkeletonLine className="h-4 w-1/2" />
        <SkeletonLine className="w-1/3" />
      </div>
      <div className="min-h-0 flex-1 p-4">
        <SkeletonBlock className="h-full w-full rounded-xl" />
      </div>
    </section>
  );
}

export function SourcesHubPanelSkeleton({
  className,
  variant = "panel",
}: {
  className?: string;
  variant?: "panel" | "drawer";
}) {
  return <SourcesHubSkeletonContent className={className} variant={variant} />;
}

function ChatSkeletonContent({
  variant = "thread",
  showHub = true,
}: {
  variant?: "new" | "thread";
  showHub?: boolean;
}) {
  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChatHeaderSkeleton />
        <ChatCanvasSkeletonContent variant={variant} />
      </div>
      {showHub ? <SourcesHubSkeletonContent /> : null}
    </div>
  );
}

export function ChatRouteSkeleton({
  variant = "thread",
}: {
  variant?: "new" | "thread";
}) {
  return (
    <DashboardFrame>
      <ChatSkeletonContent showHub={false} variant={variant} />
    </DashboardFrame>
  );
}

function ObservabilityFilterSkeleton() {
  return (
    <aside className="hidden w-[260px] shrink-0 border-r border-border bg-card p-3 md:block">
      <div className="mb-4 flex items-center justify-between">
        <SkeletonLine className="h-4 w-28" />
        <SkeletonBlock className="h-8 w-16 rounded-md" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 7 }).map((_, index) => (
          <div className="space-y-2" key={index}>
            <SkeletonLine className="w-24" />
            <SkeletonBlock className="h-9 rounded-lg" />
          </div>
        ))}
      </div>
    </aside>
  );
}

function ObservabilitySkeletonContent() {
  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ObservabilityFilterSkeleton />
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card">
          <div className="shrink-0 border-b border-border px-3 py-2">
            <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <SkeletonBlock className="size-8 rounded-md md:hidden" />
                <SkeletonLine className="h-4 w-32" />
                <SkeletonBlock className="h-6 w-16 rounded-full" />
              </div>
              <div className="flex shrink-0 gap-2">
                <SkeletonBlock className="h-8 w-24 rounded-md" />
                <SkeletonBlock className="h-8 w-8 rounded-md" />
              </div>
            </div>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <TraceListSkeletonRows allWorkspacesSelected={false} />
          </div>
        </section>
      </div>
    </main>
  );
}

export function ObservabilityRouteSkeleton() {
  return (
    <DashboardFrame>
      <ObservabilitySkeletonContent />
    </DashboardFrame>
  );
}

function SkillDetailSkeletonContent({
  kind = "skills",
}: {
  kind?: "skills" | "mcp";
}) {
  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card">
        <div className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <SkeletonBlock className="size-8 rounded-full" />
              <SkeletonBlock className="size-10 rounded-lg" />
              <div className="space-y-2">
                <SkeletonLine className="h-4 w-44" />
                <SkeletonLine className="w-64 max-w-full" />
              </div>
            </div>
            <SkeletonBlock className="h-9 w-28 rounded-md" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <article className="min-w-0 rounded-2xl border border-border bg-background p-5 shadow-xs">
              {kind === "skills" ? (
                <div className="mb-5 flex gap-2 border-b border-border pb-3">
                  <SkeletonBlock className="h-8 w-24" />
                  <SkeletonBlock className="h-8 w-24" />
                  <SkeletonBlock className="h-8 w-24" />
                </div>
              ) : (
                <SkeletonLine className="mb-5 h-5 w-36" />
              )}
              <div className="space-y-3">
                {Array.from({ length: 11 }).map((_, index) => (
                  <SkeletonLine
                    className={index % 4 === 0 ? "w-2/3" : "w-full"}
                    key={index}
                  />
                ))}
              </div>
            </article>
            <aside className="h-fit space-y-3 rounded-2xl border border-border bg-background p-4 shadow-xs">
              {Array.from({ length: 5 }).map((_, index) => (
                <div className="space-y-2" key={index}>
                  <SkeletonLine className="w-20" />
                  <SkeletonLine className="w-36" />
                </div>
              ))}
            </aside>
          </div>
        </div>
      </section>
    </main>
  );
}

export function SkillDetailRouteSkeleton({
  kind = "skills",
}: {
  kind?: "skills" | "mcp";
}) {
  return (
    <DashboardFrame>
      <SkillDetailSkeletonContent kind={kind} />
    </DashboardFrame>
  );
}

function BillingSkeletonContent({ checkout = false }: { checkout?: boolean }) {
  return (
    <main
      className={
        checkout
          ? "flex h-full min-h-0 flex-1 items-center justify-center p-6"
          : "mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-6 text-center"
      }
    >
      <section
        className={cx(
          "w-full max-w-md text-center",
          checkout &&
            "rounded-xl border border-border bg-card px-6 py-7 shadow-sm",
        )}
      >
        <SkeletonBlock className="mx-auto size-12 rounded-xl border border-border" />
        <SkeletonLine className="mx-auto mt-5 h-6 w-48 max-w-full" />
        <SkeletonLine className="mx-auto mt-2 h-4 w-72 max-w-full" />
        <SkeletonLine className="mx-auto mt-2 h-4 w-56 max-w-full" />
        <SkeletonBlock className="mx-auto mt-6 h-8 w-28" />
      </section>
    </main>
  );
}

export function BillingRouteSkeleton({
  checkout = false,
}: {
  checkout?: boolean;
}) {
  return (
    <DashboardFrame>
      <BillingSkeletonContent checkout={checkout} />
    </DashboardFrame>
  );
}

export { AuthRouteSkeleton } from "./auth-loading-skeleton";

export function SettingsStandaloneRouteSkeleton() {
  return (
    <main className="container p-4 md:p-6">
      <div className="flex w-full flex-col gap-4 md:gap-6">
        <div className="flex w-fit gap-1 rounded-lg bg-muted p-1">
          {Array.from({ length: 3 }, (_, index) => (
            <SkeletonBlock key={index} className="h-7 w-24" />
          ))}
        </div>
        <section className="flex w-full flex-col gap-6">
          <SettingsCardRouteSkeleton withAvatar />
          <SettingsCardRouteSkeleton />
          <SettingsCardRouteSkeleton />
        </section>
      </div>
    </main>
  );
}

function SettingsCardRouteSkeleton({ withAvatar }: { withAvatar?: boolean }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <SkeletonLine className="h-5 w-1/3 md:h-5" />
        <SkeletonLine className="mt-1 w-2/3" />
      </CardHeader>

      <CardContent>
        {withAvatar ? (
          <div className="flex items-center gap-4">
            <SkeletonBlock className="size-16 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-3">
              <SkeletonBlock className="h-10 rounded-md" />
              <SkeletonLine className="w-48 max-w-full" />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <SkeletonBlock className="h-10 rounded-md" />
            <SkeletonBlock className="h-10 rounded-md" />
          </div>
        )}
      </CardContent>

      <CardFooter className="flex-col justify-between gap-4 md:flex-row">
        <SkeletonLine className="my-0.5 w-56 max-w-full" />
        <SkeletonBlock className="h-8 w-20 rounded-md md:ms-auto" />
      </CardFooter>
    </Card>
  );
}
