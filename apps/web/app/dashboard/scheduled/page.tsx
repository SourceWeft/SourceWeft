"use client";

import { Suspense } from "react";
import { ScheduledTasksPage } from "./_components/scheduled-tasks-page";

export default function ScheduledPage() {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* `useSearchParams` needs a boundary above it. */}
      <Suspense fallback={null}>
        <ScheduledTasksPage />
      </Suspense>
    </main>
  );
}
