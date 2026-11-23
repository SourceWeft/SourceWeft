"use client";

import { Suspense } from "react";
import { AssistantPage } from "./_components/assistant-page";
import { AssistantRouteSkeleton } from "./_components/assistant-skeleton";

export default function AssistantRoute() {
  return (
    // `useSearchParams` (the `?ticket=` a notification links to) needs a
    // boundary above it; it falls back to the route's own skeleton.
    <Suspense fallback={<AssistantRouteSkeleton />}>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <AssistantPage />
      </main>
    </Suspense>
  );
}
