export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-6" aria-busy="true">
      <div className="h-6 w-48 animate-pulse rounded bg-muted" />
      <div className="h-20 w-full animate-pulse rounded-xl bg-muted" />
      <div className="h-20 w-full animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
