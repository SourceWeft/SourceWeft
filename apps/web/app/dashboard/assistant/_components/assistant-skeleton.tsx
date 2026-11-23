import { cn } from "@sourceweft/ui-web/lib/utils";

function Block({ className }: { className?: string }) {
  return (
    <div
      className={cn("max-w-full animate-pulse rounded-md bg-muted", className)}
    />
  );
}

/** The assistant page before it renders, in the same column and order. */
export function AssistantRouteSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div
        className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 p-4 md:p-6"
        aria-hidden="true"
      >
        <div className="space-y-2">
          <Block className="h-6 w-48" />
          <Block className="h-4 w-80" />
        </div>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-3">
            <Block className="h-16 w-3/4" />
            <Block className="ml-auto h-12 w-2/3" />
            <Block className="h-16 w-3/4" />
            <Block className="h-24 w-full" />
          </div>
          <div className="space-y-2">
            <Block className="h-20 w-full" />
            <Block className="h-20 w-full" />
          </div>
        </div>
      </div>
    </main>
  );
}
