"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  agentTaskErrorCode,
  useAgentTask,
  useAgentTaskRuns,
} from "../../../../lib/scheduled-tasks";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { useTaskActions } from "./task-actions";
import { TaskMenu } from "./task-menu";
import {
  RunStatusBadge,
  TaskStatusBadge,
  TaskStatusReason,
} from "./task-status";
import { ScheduledTaskDetailSkeleton } from "./scheduled-tasks-skeleton";
import { useScheduleText } from "./use-schedule-text";

export function TaskDetail({ taskId }: { taskId: string }) {
  const t = useTranslations("dashboardScheduled");
  const router = useRouter();
  const { workspaceId, hasWorkspaceHydrated } = useDashboardChatState();
  const { describeRule, formatInstant } = useScheduleText();
  const task = useAgentTask(workspaceId, taskId);
  const runs = useAgentTaskRuns(workspaceId, taskId);
  const actions = useTaskActions(workspaceId);

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link href="/dashboard/scheduled">
        <ArrowLeft className="size-4" />
        {t("detail.back")}
      </Link>
    </Button>
  );

  // `isPending`, not `isLoading`: a first fetch paused for the network has no
  // data yet and must not fall through to "could not load".
  if (!hasWorkspaceHydrated || (Boolean(workspaceId) && task.isPending)) {
    return <ScheduledTaskDetailSkeleton label={t("page.loading")} />;
  }
  if (task.isError || !task.data) {
    return (
      <div className="flex flex-col gap-3 p-6">
        {back}
        <p className="text-sm text-destructive" role="alert">
          {agentTaskErrorCode(task.error) === "AGENT_TASK_NOT_FOUND"
            ? t("detail.notFound")
            : t("page.loadError")}
        </p>
      </div>
    );
  }

  const data = task.data;
  const rows = runs.data?.pages.flatMap((page) => page.runs) ?? [];

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-6">
      {back}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-xl font-semibold">{data.name}</h1>
            <TaskStatusBadge task={data} />
          </div>
          <p className="text-sm text-muted-foreground">
            {describeRule(data.schedule.rule, data.schedule.timezone)}
            {data.schedule.rule.kind !== "manual"
              ? ` · ${data.schedule.timezone}`
              : ""}
          </p>
          {data.status === "active" && data.schedule.nextDueAt ? (
            <p className="text-xs text-muted-foreground">
              {t("list.nextRun", {
                at: formatInstant(
                  data.schedule.nextDueAt,
                  data.schedule.timezone,
                ),
              })}
            </p>
          ) : null}
          <TaskStatusReason task={data} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" onClick={() => void actions.runNow(data)}>
            {t("actions.runNow")}
          </Button>
          <TaskMenu
            task={data}
            workspaceId={workspaceId}
            onDeleted={() => router.push("/dashboard/scheduled")}
          />
        </div>
      </header>

      <section className="grid gap-1.5">
        <h2 className="text-sm font-medium">{t("detail.prompt")}</h2>
        <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm">
          {data.prompt}
        </p>
      </section>

      <section className="grid gap-2">
        <h2 className="text-sm font-medium">{t("detail.history")}</h2>
        {runs.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("page.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noRuns")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {rows.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <RunStatusBadge run={run} />
                    <span>
                      {formatInstant(run.scheduledFor, data.schedule.timezone)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`trigger.${run.triggerKind}`)}
                      {run.isCatchUp ? ` · ${t("detail.catchUp")}` : ""}
                    </span>
                  </div>
                  {run.skipReason ? (
                    <p className="text-xs text-muted-foreground">
                      {t(`skipReason.${run.skipReason}`)}
                    </p>
                  ) : null}
                </div>
                {run.threadId ? (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/dashboard/chat/${encodeURIComponent(run.threadId)}`}
                    >
                      {t("detail.openResult")}
                    </Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {runs.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            disabled={runs.isFetchingNextPage}
            onClick={() => runs.fetchNextPage()}
          >
            {t("inbox.loadMore")}
          </Button>
        ) : null}
      </section>
    </div>
  );
}
