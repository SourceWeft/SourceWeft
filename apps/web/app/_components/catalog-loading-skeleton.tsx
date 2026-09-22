import { cn } from "@sourceweft/ui-web/lib/utils";

function SkillSkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "max-w-full animate-pulse rounded-md bg-muted/80",
        className,
      )}
    />
  );
}

function SkillSkeletonLine({ className }: { className?: string }) {
  return <SkillSkeletonBlock className={cn("h-3", className)} />;
}

export function SkillsCatalogSkeletonGrid({
  variant = "page",
}: {
  variant?: "page" | "modal";
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        variant === "modal"
          ? "grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))]"
          : "grid-cols-[repeat(auto-fill,minmax(260px,1fr))] 2xl:grid-cols-4",
      )}
    >
      {Array.from({ length: variant === "modal" ? 6 : 9 }).map((_, index) => (
        <article
          className={cn(
            "flex flex-col overflow-hidden rounded-2xl border border-border bg-background px-4 pb-4 pt-4 shadow-xs",
            variant === "modal" ? "min-h-[190px]" : "min-h-[202px]",
          )}
          key={index}
        >
          <div className="flex min-w-0 items-center gap-3">
            <SkillSkeletonBlock className="size-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <SkillSkeletonLine className="w-36" />
              <SkillSkeletonLine className="w-20" />
            </div>
            <SkillSkeletonBlock className="h-5 w-16 rounded-full" />
          </div>
          <div className="mt-3 space-y-2">
            <SkillSkeletonLine className="w-full" />
            <SkillSkeletonLine className="w-11/12" />
            <SkillSkeletonLine className="w-3/4" />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <SkillSkeletonBlock className="h-5 w-16 rounded-full" />
            <SkillSkeletonBlock className="h-5 w-20 rounded-full" />
          </div>
          <div className="mt-auto grid grid-cols-2 gap-2 border-t border-border pt-3">
            <SkillSkeletonBlock className="h-7 rounded-full" />
            <SkillSkeletonBlock className="h-7 rounded-full" />
          </div>
        </article>
      ))}
    </div>
  );
}

export function McpSkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <article
          className="flex h-[286px] flex-col rounded-2xl border border-border bg-background p-4 shadow-xs"
          key={index}
        >
          <div className="flex items-center gap-3">
            <div className="size-9 animate-pulse rounded-full bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
          <div className="mt-auto flex h-11 items-end gap-2 border-t border-border pt-3">
            <div className="h-7 flex-1 animate-pulse rounded-full bg-muted" />
            <div className="size-7 animate-pulse rounded-lg bg-muted" />
            <div className="size-7 animate-pulse rounded-lg bg-muted" />
          </div>
        </article>
      ))}
    </div>
  );
}

export function CatalogRouteSkeleton({ kind }: { kind: "skills" | "mcp" }) {
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <aside className="hidden min-h-0 w-[260px] shrink-0 overflow-hidden border-r border-border bg-card md:block">
        <div className="space-y-3 border-b border-border p-3">
          <SkillSkeletonLine className="h-4 w-20" />
          <SkillSkeletonBlock className="h-8 w-full" />
        </div>
        {Array.from({ length: 6 }, (_, index) => (
          <div
            className="space-y-2 border-b border-border px-3 py-3"
            key={index}
          >
            <SkillSkeletonLine className="w-24" />
            {index < 2 && <SkillSkeletonBlock className="h-7 w-full" />}
          </div>
        ))}
      </aside>
      <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-card px-4 py-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <SkillSkeletonBlock className="h-8 w-16 md:hidden" />
            <SkillSkeletonBlock className="h-8 w-40" />
          </div>
          <SkillSkeletonBlock className="h-8 w-24" />
        </div>
        {kind === "skills" ? (
          <SkillsCatalogSkeletonGrid />
        ) : (
          <McpSkeletonGrid />
        )}
      </section>
    </main>
  );
}
