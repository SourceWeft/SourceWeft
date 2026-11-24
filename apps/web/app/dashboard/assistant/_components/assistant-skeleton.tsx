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
        className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6"
        aria-hidden="true"
      >
        <div className="space-y-2">
          <Block className="h-6 w-44" />
          <Block className="h-4 w-32 md:w-80" />
        </div>
        <Block className="h-11 w-full md:hidden" />
        <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_17rem] md:gap-8">
          <div className="flex flex-1 flex-col gap-4">
            <Block className="h-14 w-3/4 rounded-2xl" />
            <Block className="ml-auto h-10 w-2/3 rounded-2xl" />
            <Block className="h-20 w-5/6 rounded-2xl" />
            <Block className="mt-auto h-12 w-full rounded-2xl" />
          </div>
          <div className="space-y-3 max-md:hidden">
            <Block className="h-16 w-full" />
            <Block className="h-16 w-full" />
          </div>
        </div>
      </div>
    </main>
  );
}
