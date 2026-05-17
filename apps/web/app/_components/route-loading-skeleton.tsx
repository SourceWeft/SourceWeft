import type { ReactNode } from "react";

type SkeletonProps = {
  className?: string;
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function SkeletonBlock({ className }: SkeletonProps) {
  return (
    <div className={cx("animate-pulse rounded-md bg-muted/80", className)} />
  );
}

function SkeletonLine({ className }: SkeletonProps) {
  return <SkeletonBlock className={cx("h-3", className)} />;
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

function isSkillDetailRoute(pathname?: string | null) {
  if (!pathname) {
    return false;
  }
  const normalized = pathname.replace(/\/+$/, "");
  return normalized.startsWith("/dashboard/skills/") &&
    normalized !== "/dashboard/skills";
}

function DashboardSkeletonContentForPath({
  pathname,
}: {
  pathname?: string | null;
}) {
  if (isChatRoute(pathname)) {
    return <ChatSkeletonContent />;
  }
  if (pathname?.startsWith("/dashboard/observability")) {
    return <ObservabilitySkeletonContent />;
  }
  if (isSkillDetailRoute(pathname)) {
    return <SkillDetailSkeletonContent />;
  }
  if (pathname?.startsWith("/dashboard/skills")) {
    return <SkillsSkeletonContent />;
  }
  if (pathname?.startsWith("/dashboard/billing")) {
    return <BillingSkeletonContent />;
  }
  return <DashboardHomeSkeletonContent />;
}

function DashboardSidebarSkeleton({
  pathname,
}: {
  pathname?: string | null;
}) {
  const hasChatPanel = isChatRoute(pathname);

  return (
    <aside
      className={cx(
        "hidden h-svh shrink-0 bg-sidebar text-sidebar-foreground md:flex",
        hasChatPanel ? "w-[360px] border-r border-border" : "w-14",
      )}
    >
      <div className="flex h-full w-14 shrink-0 flex-col items-center justify-between border-r border-sidebar-border px-2 py-4">
        <div className="flex flex-col items-center gap-2">
          <SkeletonBlock className="size-10 rounded-xl" />
          <div className="mt-2 flex flex-col items-center gap-1">
            {Array.from({ length: 4 }).map((_, index) => (
              <SkeletonBlock className="size-10 rounded-xl" key={index} />
            ))}
          </div>
        </div>
        <SkeletonBlock className="size-10 rounded-full" />
      </div>

      {hasChatPanel ? (
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden border-r border-sidebar-border bg-card">
          <div className="shrink-0 border-b border-border px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <SkeletonLine className="h-3.5 w-28" />
                <SkeletonLine className="w-40" />
              </div>
              <SkeletonBlock className="size-8 rounded-md" />
            </div>
            <SkeletonBlock className="mt-3 h-9 rounded-xl" />
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-hidden px-3 py-3">
            {Array.from({ length: 2 }).map((_, groupIndex) => (
              <section className="space-y-2" key={groupIndex}>
                <div className="flex items-center justify-between">
                  <SkeletonLine className="w-24" />
                  <SkeletonBlock className="h-6 w-12" />
                </div>
                {Array.from({ length: groupIndex === 0 ? 4 : 3 }).map(
                  (_, rowIndex) => (
                    <div
                      className="rounded-lg border border-transparent px-2 py-2"
                      key={rowIndex}
                    >
                      <SkeletonLine
                        className={rowIndex % 2 ? "w-40" : "w-52"}
                      />
                      <SkeletonLine className="mt-2 w-24" />
                    </div>
                  ),
                )}
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function DashboardMobileBottomNavSkeleton() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 md:hidden">
      <div className="mx-auto grid max-w-md grid-cols-4 gap-1">
        {Array.from({ length: 4 }).map((_, index) => (
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

export function DashboardShellRouteSkeleton({
  pathname,
}: {
  pathname?: string | null;
}) {
  return (
    <main className="flex h-svh min-h-0 w-full overflow-hidden bg-background text-foreground">
      <DashboardSidebarSkeleton pathname={pathname} />
      <section className="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <DashboardSkeletonContentForPath pathname={pathname} />
      </section>
      <DashboardMobileBottomNavSkeleton />
    </main>
  );
}

export function DashboardContentRouteSkeleton({
  children,
}: {
  children: ReactNode;
}) {
  return <div className="min-h-0 flex-1">{children}</div>;
}

export function DashboardHomeRouteSkeleton() {
  return (
    <DashboardFrame>
      <DashboardHomeSkeletonContent />
    </DashboardFrame>
  );
}

function DashboardHomeHeaderSkeleton() {
  return (
    <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
      <div className="flex min-h-16 flex-wrap items-start justify-between gap-2 px-3 py-2 md:h-16 md:flex-nowrap md:items-center md:gap-3 md:px-6 md:py-0 xl:px-8">
        <div className="flex min-w-0 flex-1 self-stretch items-center gap-2 overflow-hidden md:gap-2.5">
          <SkeletonBlock className="size-8 rounded-md md:hidden" />
          <div className="min-w-0 space-y-2">
            <SkeletonLine className="h-3.5 w-28" />
            <SkeletonLine className="w-44" />
          </div>
        </div>
        <div className="flex h-10 shrink-0 items-center gap-2">
          <SkeletonBlock className="hidden h-9 w-64 rounded-xl lg:block" />
          <SkeletonBlock className="h-9 w-28 rounded-xl" />
        </div>
      </div>
    </header>
  );
}

function DashboardHomeSkeletonContent() {
  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/20">
      <DashboardHomeHeaderSkeleton />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6 xl:p-8">
        <div className="mx-auto flex max-w-[1480px] flex-col gap-6">
          <section className="hidden rounded-lg border border-border bg-card p-5 md:block">
            <div className="mb-5 flex items-center justify-between">
              <div className="space-y-2">
                <SkeletonLine className="h-4 w-36" />
                <SkeletonLine className="w-56" />
              </div>
              <SkeletonBlock className="h-9 w-32 rounded-xl" />
            </div>
            <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
              <SkeletonBlock className="h-48 rounded-lg" />
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <SkeletonBlock className="h-10 rounded-lg" key={index} />
                ))}
              </div>
            </div>
          </section>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                className="rounded-lg border border-border bg-card p-4"
                key={index}
              >
                <SkeletonBlock className="mb-4 h-24 rounded-lg" />
                <SkeletonLine className="mb-2 w-32" />
                <SkeletonLine className="w-44" />
              </div>
            ))}
          </section>
        </div>
      </div>
    </main>
  );
}

function ChatHeaderSkeleton() {
  return (
    <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
      <div className="flex min-h-16 flex-wrap items-start justify-between gap-2 px-3 py-2 md:h-16 md:flex-nowrap md:items-center md:gap-3 md:px-6 md:py-0 xl:px-8">
        <div className="flex min-w-0 flex-1 self-stretch items-center gap-2 overflow-hidden md:gap-2.5">
          <SkeletonBlock className="size-8 rounded-md md:hidden" />
          <SkeletonLine className="h-4 w-32" />
        </div>
        <div className="contents md:ml-auto md:flex md:h-10 md:shrink-0 md:items-center md:gap-2">
          <SkeletonBlock className="h-8 w-36 rounded-xl md:h-10 md:w-44" />
          <SkeletonBlock className="size-8 rounded-md md:size-10" />
        </div>
      </div>
    </header>
  );
}

function ChatCanvasSkeletonContent() {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 space-y-5 overflow-hidden px-4 py-6 md:px-8 lg:px-12">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            className={cx("flex gap-3", index % 2 === 1 && "justify-end")}
            key={index}
          >
            {index % 2 === 0 ? (
              <SkeletonBlock className="size-8 shrink-0 rounded-full" />
            ) : null}
            <div
              className={cx(
                "space-y-2 rounded-lg border border-border bg-card p-3",
                index % 2 === 0
                  ? "w-[min(720px,82%)]"
                  : "w-[min(520px,72%)]",
              )}
            >
              <SkeletonLine className="w-24" />
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-4/5" />
            </div>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-border bg-background p-3 md:p-4">
        <div className="mx-auto max-w-4xl rounded-lg border border-border bg-card p-3">
          <SkeletonLine className="mb-4 w-3/5" />
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <SkeletonBlock className="size-8 rounded-md" />
              <SkeletonBlock className="size-8 rounded-md" />
              <SkeletonBlock className="h-8 w-24 rounded-md" />
            </div>
            <SkeletonBlock className="h-8 w-20 rounded-md" />
          </div>
        </div>
      </div>
    </section>
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
        "flex h-full shrink-0 flex-col overflow-x-hidden bg-background",
        className ??
          (variant === "drawer"
            ? "w-full min-w-0"
            : "hidden w-[410px] border-l md:flex"),
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
          {Array.from({ length: 5 }).map((_, index) => (
            <SkeletonBlock className="h-7 w-20 rounded-lg" key={index} />
          ))}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-hidden px-3 py-3">
        {Array.from({ length: 4 }).map((_, sectionIndex) => (
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
                    <SkeletonLine
                      className={rowIndex % 2 ? "w-36" : "w-48"}
                    />
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

export function ChatCanvasPanelSkeleton() {
  return <ChatCanvasSkeletonContent />;
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

function ChatSkeletonContent() {
  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChatHeaderSkeleton />
        <ChatCanvasSkeletonContent />
      </div>
      <SourcesHubSkeletonContent />
    </div>
  );
}

export function ChatRouteSkeleton() {
  return (
    <DashboardFrame>
      <ChatSkeletonContent />
    </DashboardFrame>
  );
}

function ObservabilityFilterSkeleton() {
  return (
    <aside className="hidden w-72 shrink-0 border-r border-border bg-background p-3 md:block">
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
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
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
          <div className="hidden grid-cols-[150px_300px_90px_90px_150px_90px_minmax(180px,1fr)] border-b border-border bg-muted/30 px-3 py-2 text-xs md:grid">
            {Array.from({ length: 7 }).map((_, index) => (
              <SkeletonLine className="w-20" key={index} />
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {Array.from({ length: 12 }).map((_, index) => (
              <div
                className="grid grid-cols-[150px_300px_90px_90px_150px_90px_minmax(180px,1fr)] gap-0 border-b border-border px-3 py-2 max-md:block"
                key={index}
              >
                <SkeletonLine className="mb-2 w-28 md:mb-0" />
                <div className="space-y-2">
                  <SkeletonLine className="w-48" />
                  <SkeletonLine className="w-32" />
                </div>
                <SkeletonBlock className="hidden h-5 w-16 rounded-full md:block" />
                <SkeletonLine className="hidden w-16 md:block" />
                <SkeletonLine className="hidden w-28 md:block" />
                <SkeletonLine className="hidden w-12 md:block" />
                <SkeletonLine className="hidden w-44 md:block" />
              </div>
            ))}
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

function SkillsFilterSkeleton() {
  return (
    <aside className="hidden w-72 shrink-0 border-r border-border bg-background p-3 md:block">
      <div className="mb-4 flex items-center justify-between">
        <SkeletonLine className="h-4 w-20" />
        <SkeletonLine className="w-10" />
      </div>
      <SkeletonBlock className="mb-4 h-9 rounded-xl" />
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, groupIndex) => (
          <section className="space-y-2" key={groupIndex}>
            <SkeletonLine className="w-24" />
            {Array.from({ length: groupIndex === 0 ? 5 : 2 }).map(
              (_, rowIndex) => (
                <SkeletonBlock
                  className={cx(
                    "h-8 rounded-lg",
                    rowIndex % 2 ? "w-11/12" : "w-full",
                  )}
                  key={rowIndex}
                />
              ),
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}

function SkillsSkeletonContent() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SkillsFilterSkeleton />
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="px-4 py-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <SkeletonBlock className="h-8 w-24 rounded-md md:hidden" />
                  <SkeletonBlock className="h-8 w-44 rounded-full" />
                </div>
                <SkeletonBlock className="h-8 w-32 rounded-md" />
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 2xl:grid-cols-4">
                {Array.from({ length: 9 }).map((_, index) => (
                  <div
                    className="rounded-lg border border-border bg-background p-4 shadow-xs"
                    key={index}
                  >
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <SkeletonBlock className="size-10 shrink-0 rounded-lg" />
                        <div className="min-w-0 space-y-2">
                          <SkeletonLine className="w-36" />
                          <SkeletonLine className="w-20" />
                        </div>
                      </div>
                      <SkeletonBlock className="h-7 w-20 rounded-md" />
                    </div>
                    <SkeletonLine className="mb-2 w-full" />
                    <SkeletonLine className="mb-5 w-4/5" />
                    <div className="flex flex-wrap gap-1.5">
                      <SkeletonBlock className="h-5 w-16 rounded-full" />
                      <SkeletonBlock className="h-5 w-20 rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export function SkillsRouteSkeleton() {
  return (
    <DashboardFrame>
      <SkillsSkeletonContent />
    </DashboardFrame>
  );
}

function SkillDetailSkeletonContent() {
  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <div className="shrink-0 border-b border-border px-4 py-3">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <SkeletonBlock className="size-8 rounded-md md:hidden" />
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
            <article className="min-w-0 rounded-lg border border-border bg-background p-5 shadow-xs">
              <div className="mb-5 flex gap-2">
                <SkeletonBlock className="h-8 w-24 rounded-md" />
                <SkeletonBlock className="h-8 w-24 rounded-md" />
              </div>
              <div className="space-y-3">
                {Array.from({ length: 11 }).map((_, index) => (
                  <SkeletonLine
                    className={index % 4 === 0 ? "w-2/3" : "w-full"}
                    key={index}
                  />
                ))}
              </div>
            </article>
            <aside className="h-fit space-y-3 rounded-lg border border-border bg-background p-4 shadow-xs">
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

export function SkillDetailRouteSkeleton() {
  return (
    <DashboardFrame>
      <SkillDetailSkeletonContent />
    </DashboardFrame>
  );
}

function BillingSkeletonContent() {
  return (
    <main className="flex h-full min-h-0 flex-1 items-center justify-center bg-background p-6">
      <section className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <SkeletonBlock className="mx-auto mb-5 size-12 rounded-full" />
        <SkeletonLine className="mx-auto mb-3 h-5 w-48" />
        <SkeletonLine className="mx-auto mb-2 w-72 max-w-full" />
        <SkeletonLine className="mx-auto mb-6 w-56 max-w-full" />
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-left">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="flex items-center justify-between gap-3" key={index}>
              <SkeletonLine className="w-28" />
              <SkeletonLine className="w-20" />
            </div>
          ))}
        </div>
        <SkeletonBlock className="mt-5 h-10 w-full rounded-md" />
      </section>
    </main>
  );
}

export function BillingRouteSkeleton() {
  return (
    <DashboardFrame>
      <BillingSkeletonContent />
    </DashboardFrame>
  );
}

export function AuthRouteSkeleton() {
  return (
    <main className="flex min-h-svh w-full items-center justify-center bg-background p-4 md:p-6">
      <section className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <SkeletonBlock className="size-10 rounded-lg" />
          <div className="space-y-2">
            <SkeletonLine className="h-4 w-36" />
            <SkeletonLine className="w-52" />
          </div>
        </div>
        <div className="space-y-4">
          <SkeletonBlock className="h-10 rounded-md" />
          <SkeletonBlock className="h-10 rounded-md" />
          <SkeletonBlock className="h-10 rounded-md" />
          <SkeletonLine className="mx-auto w-40" />
        </div>
      </section>
    </main>
  );
}

export function SettingsRouteSkeleton() {
  return (
    <DashboardFrame>
      <SettingsSkeletonContent />
    </DashboardFrame>
  );
}

export function SettingsStandaloneRouteSkeleton() {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <SettingsSkeletonContent />
    </main>
  );
}

function SettingsSkeletonContent() {
  return (
    <div className="h-full overflow-hidden bg-background p-4 md:p-6">
      <div className="container mx-auto max-w-5xl">
        <SkeletonLine className="mb-5 h-5 w-40" />
        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <nav className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <SkeletonBlock className="h-9 rounded-md" key={index} />
            ))}
          </nav>
          <section className="rounded-lg border border-border bg-card p-5">
            <SkeletonLine className="mb-6 h-4 w-36" />
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, index) => (
                <div className="space-y-2" key={index}>
                  <SkeletonLine className="w-28" />
                  <SkeletonBlock className="h-10 rounded-md" />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function LandingRouteSkeleton() {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 md:px-6">
        <div className="flex items-center gap-3">
          <SkeletonBlock className="size-9 rounded-lg" />
          <SkeletonLine className="w-28" />
        </div>
        <div className="hidden items-center gap-6 md:flex">
          <SkeletonLine className="w-16" />
          <SkeletonLine className="w-16" />
          <SkeletonLine className="w-16" />
        </div>
        <SkeletonBlock className="h-9 w-24 rounded-md" />
      </header>
      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-12 md:grid-cols-[1fr_420px] md:px-6 md:py-20">
        <div className="space-y-5">
          <SkeletonLine className="h-5 w-32" />
          <SkeletonBlock className="h-16 w-full max-w-xl rounded-lg" />
          <SkeletonLine className="w-full max-w-lg" />
          <SkeletonLine className="w-4/5 max-w-md" />
          <div className="flex gap-3 pt-2">
            <SkeletonBlock className="h-10 w-32 rounded-md" />
            <SkeletonBlock className="h-10 w-28 rounded-md" />
          </div>
        </div>
        <SkeletonBlock className="h-72 rounded-lg" />
      </section>
    </main>
  );
}

export function DocumentRouteSkeleton() {
  return (
    <main className="min-h-svh bg-background px-4 py-10 text-foreground md:px-6">
      <article className="mx-auto max-w-3xl">
        <SkeletonLine className="mb-4 h-6 w-44" />
        <SkeletonLine className="mb-8 w-72 max-w-full" />
        <div className="space-y-4">
          {Array.from({ length: 14 }).map((_, index) => (
            <SkeletonLine
              className={index % 5 === 0 ? "w-2/3" : "w-full"}
              key={index}
            />
          ))}
        </div>
      </article>
    </main>
  );
}
