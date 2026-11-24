"use client";

import { use } from "react";
import { TaskDetail } from "../_components/task-detail";

export default function ScheduledTaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = use(params);
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <TaskDetail taskId={taskId} />
    </main>
  );
}
