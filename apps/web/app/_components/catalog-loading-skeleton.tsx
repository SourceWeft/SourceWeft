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

/** A text line drawn at the height of the line box it stands in for. */
function SkeletonTextRow({
  className,
  bar,
}: {
  className?: string;
  bar: string;
}) {
  return (
    <div className={cn("flex items-center", className)}>
      <SkillSkeletonLine className={bar} />
    </div>
  );
}

// The skeleton cards mirror the real cards' spacing at each breakpoint
// (skills-gallery `SkillCard`, mcp-market `McpCard`), so the grid keeps its
// height when the data arrives: compact on a phone, unchanged from `sm` up.
export function SkillsCatalogSkeletonGrid({
  variant = "page",
}: {
  variant?: "page" | "modal";
}) {
  return (
    <div
      className={cn(
        "grid gap-2.5 sm:gap-4",
        variant === "modal"
          ? "grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))]"
          : "grid-cols-[repeat(auto-fill,minmax(260px,1fr))] 2xl:grid-cols-4",
      )}
    >
      {Array.from({ length: variant === "modal" ? 6 : 9 }).map((_, index) => (
        <article
          className={cn(
            "flex flex-col overflow-hidden rounded-xl border border-border bg-background p-3 shadow-xs sm:rounded-2xl sm:p-4",
            variant === "modal" ? "sm:min-h-[190px]" : "sm:min-h-[202px]",
          )}
          key={index}
        >
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <SkillSkeletonBlock className="size-8 shrink-0 rounded-lg sm:size-9" />
            <SkeletonTextRow bar="w-36" className="h-5 min-w-0 flex-1 sm:h-6" />
            <SkillSkeletonBlock className="h-5 w-16 rounded-full" />
          </div>
          <div className="mt-2 sm:mt-3 sm:min-h-[60px]">
            <SkeletonTextRow bar="w-full" className="h-[1.125rem] sm:h-5" />
            <SkeletonTextRow bar="w-11/12" className="h-[1.125rem] sm:h-5" />
            <SkeletonTextRow bar="w-3/4" className="hidden sm:flex sm:h-5" />
          </div>
          <div className="mt-2 flex gap-1 overflow-hidden sm:mt-3 sm:flex-wrap sm:gap-1.5">
            <SkillSkeletonBlock className="h-5 w-16 shrink-0 rounded-full" />
            <SkillSkeletonBlock className="h-5 w-20 shrink-0 rounded-full" />
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-border pt-2.5 sm:mt-auto sm:pt-3">
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
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <article
          className="flex flex-col rounded-xl border border-border bg-background p-3 shadow-xs sm:min-h-[286px] sm:rounded-2xl sm:p-4"
          key={index}
        >
          <div className="flex items-start gap-2.5 sm:gap-3">
            <SkillSkeletonBlock className="size-8 shrink-0 rounded-full sm:size-9" />
            <div className="min-w-0 flex-1">
              <SkeletonTextRow bar="w-32" className="h-5 sm:h-6" />
              <SkeletonTextRow bar="h-2.5 w-20" className="h-4" />
            </div>
          </div>
          <div className="mt-2 sm:mt-3 sm:min-h-[60px]">
            <SkeletonTextRow bar="w-full" className="h-[1.125rem] sm:h-5" />
            <SkeletonTextRow bar="w-11/12" className="h-[1.125rem] sm:h-5" />
            <SkeletonTextRow bar="w-2/3" className="hidden sm:flex sm:h-5" />
          </div>
          <div className="mt-2 flex gap-1 overflow-hidden sm:mt-3 sm:gap-1.5">
            <SkillSkeletonBlock className="h-5 w-16 shrink-0 rounded-full" />
            <SkillSkeletonBlock className="h-5 w-20 shrink-0 rounded-full" />
          </div>
          <div className="mt-2.5 flex min-h-9 items-center gap-2 border-t border-border pt-2.5 sm:mt-auto sm:min-h-11 sm:pt-3">
            <SkillSkeletonBlock className="h-7 flex-1 rounded-full" />
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
