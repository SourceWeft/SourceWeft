"use client";

import { Suspense } from "react";
import { ScheduledTasksPage } from "./_components/scheduled-tasks-page";
import { ScheduledTasksRouteSkeleton } from "./_components/scheduled-tasks-skeleton";

export default function ScheduledPage() {
  return (
    // `useSearchParams` needs a boundary above it; it falls back to the same
    // skeleton as the route, never to a blank page.
    <Suspense fallback={<ScheduledTasksRouteSkeleton />}>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <ScheduledTasksPage />
      </main>
    </Suspense>
  );
}
