import { cn } from "@sourceweft/ui-web/lib/utils";

function Block({ className }: { className?: string }) {
  return (
    <div
      className={cn("max-w-full animate-pulse rounded-md bg-muted", className)}
    />
  );
}

/** Rows shaped like the task list, for while the tasks are loading. */
export function ScheduledTaskListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="grid gap-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li
          key={index}
          className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card p-4"
        >
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <Block className="h-4 w-40" />
              <Block className="h-5 w-14 rounded-full" />
            </div>
            <Block className="h-3.5 w-56" />
            <Block className="h-3 w-32" />
          </div>
          <Block className="size-8 shrink-0 rounded-lg" />
        </li>
      ))}
    </ul>
  );
}

/**
 * The whole scheduled page before it renders, laid out in the same column,
 * padding and order as the page itself, so nothing jumps when it arrives.
 */
export function ScheduledTasksRouteSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div
        className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 overflow-hidden p-4 md:p-6"
        aria-busy="true"
        data-testid="scheduled-tasks-skeleton"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Block className="h-6 w-40" />
            <Block className="h-4 w-64" />
          </div>
          <Block className="h-8 w-24 shrink-0 rounded-lg" />
        </div>
        <div>
          <Block className="h-8 w-44 rounded-lg" />
          <div className="mt-4">
            <ScheduledTaskListSkeleton />
          </div>
        </div>
      </div>
    </main>
  );
}

/** One task's page before it loads: back link, title and the run history. */
export function ScheduledTaskDetailSkeleton({ label }: { label?: string }) {
  return (
    <div
      className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-5 overflow-hidden p-4 md:p-6"
      role={label ? "status" : undefined}
      aria-busy="true"
      data-testid="scheduled-task-detail-skeleton"
    >
      {label ? <span className="sr-only">{label}</span> : null}
      <Block className="h-8 w-20 rounded-lg" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Block className="h-7 w-48" />
          <Block className="h-4 w-64" />
        </div>
        <Block className="size-8 shrink-0 rounded-lg" />
      </div>
      <Block className="h-24 w-full rounded-xl" />
      <ScheduledTaskListSkeleton rows={2} />
    </div>
  );
}
