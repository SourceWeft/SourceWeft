"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, CalendarClock } from "lucide-react";
import type { AgentTaskRun } from "@sourceweft/contracts/scheduled-tasks";
import { useScheduledRunForThread } from "../../../../../lib/scheduled-tasks";

/** What a person should be told about how this run ended, if anything. */
export function runProblem(run: AgentTaskRun) {
  if (run.detail === "needs_approval") return "needsApproval";
  if (run.detail === "timed_out") return "timedOut";
  if (run.status === "failed") return "failed";
  if (run.status === "cancelled") return "cancelled";
  return null;
}

/**
 * Sits at the top of a conversation a scheduled task made: which task it was,
 * and, when the run did not end well, in plain words what happened. A run
 * that finished says only where it came from.
 */
export function ScheduledRunNotice({
  workspaceId,
  threadId,
}: {
  workspaceId: string | null;
  threadId: string;
}) {
  const t = useTranslations("dashboardScheduled.threadNotice");
  const found = useScheduledRunForThread(workspaceId, threadId, true);
  if (!found.data) return null;
  const { run, task } = found.data;
  const problem = runProblem(run);
  const Icon = problem ? AlertTriangle : CalendarClock;
  return (
    <div
      role={problem ? "alert" : "status"}
      className={
        problem
          ? "flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm"
          : "flex shrink-0 items-start gap-2 border-b px-4 py-2 text-sm text-muted-foreground"
      }
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        {problem ? (
          <span className="mr-1 font-medium text-foreground">
            {t(`problem.${problem}`)}
          </span>
        ) : null}
        {t("from", { name: task.name })}{" "}
        <Link
          href={`/dashboard/scheduled/${task.id}`}
          className="underline underline-offset-2"
        >
          {t("open")}
        </Link>
      </p>
    </div>
  );
}
