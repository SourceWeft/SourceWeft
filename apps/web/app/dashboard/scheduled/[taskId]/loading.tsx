import { ScheduledTaskDetailSkeleton } from "../_components/scheduled-tasks-skeleton";

export default function Loading() {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <ScheduledTaskDetailSkeleton />
    </main>
  );
}
