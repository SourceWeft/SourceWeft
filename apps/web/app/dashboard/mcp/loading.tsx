export default function McpLoading() {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-[260px] shrink-0 border-r border-border bg-card md:block">
          <div className="border-b border-border px-3 py-3">
            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-4 p-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className="space-y-2" key={index}>
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                <div className="h-7 w-full animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        </aside>
        <section className="min-h-0 flex-1 bg-card p-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                className="min-h-[220px] animate-pulse rounded-2xl border border-border bg-background"
                key={index}
              />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
