"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CalendarClock, Plus } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import {
  useAgentTasks,
  useNotificationMutations,
  useUnreadNotificationCount,
} from "../../../../lib/scheduled-tasks";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { NotificationList } from "./notification-list";
import { ScheduledTaskListSkeleton } from "./scheduled-tasks-skeleton";
import { TaskFormDialog } from "./task-form-dialog";
import { TaskMenu } from "./task-menu";
import { TaskStatusBadge, TaskStatusReason } from "./task-status";
import { useScheduleText } from "./use-schedule-text";

export function ScheduledTasksPage() {
  const t = useTranslations("dashboardScheduled");
  const params = useSearchParams();
  const { workspaceId, hasWorkspaceHydrated } = useDashboardChatState();
  const { describeRule, formatInstant } = useScheduleText();
  const tasks = useAgentTasks(workspaceId);
  const unread = useUnreadNotificationCount(workspaceId).data ?? 0;
  const { markAllRead } = useNotificationMutations(workspaceId);
  const [creating, setCreating] = React.useState(false);
  const [tab, setTab] = React.useState(
    params.get("tab") === "inbox" ? "inbox" : "tasks",
  );

  const items = (tasks.data ?? []).filter((task) => task.status !== "archived");
  // Loading until the first answer arrives: `isPending`, not `isLoading`,
  // because a query paused for the network (a phone gone offline) is not
  // "loading" yet has no data, and must not read as "no tasks yet". With no
  // workspace at all the query never runs, so that case is not loading.
  const loading =
    !hasWorkspaceHydrated || (Boolean(workspaceId) && tasks.isPending);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{t("page.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("page.subtitle")}</p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={!workspaceId}>
          <Plus className="size-4" />
          {t("page.new")}
        </Button>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="tasks">{t("page.tabTasks")}</TabsTrigger>
          <TabsTrigger value="inbox">
            {t("page.tabInbox")}
            {unread > 0 ? ` (${unread})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="mt-4">
          {loading ? (
            <div role="status" aria-busy="true">
              <span className="sr-only">{t("page.loading")}</span>
              <ScheduledTaskListSkeleton />
            </div>
          ) : tasks.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {t("page.loadError")}
            </p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
              <CalendarClock className="size-8 text-muted-foreground" />
              <p className="font-medium">{t("page.emptyTitle")}</p>
              <p className="max-w-md text-sm text-muted-foreground">
                {t("page.emptyBody")}
              </p>
              <Button onClick={() => setCreating(true)}>{t("page.new")}</Button>
            </div>
          ) : (
            <ul className="grid gap-2">
              {items.map((task) => (
                <li
                  key={task.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card p-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/scheduled/${encodeURIComponent(task.id)}`}
                        className="truncate font-medium hover:underline"
                      >
                        {task.name}
                      </Link>
                      <TaskStatusBadge task={task} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {describeRule(task.schedule.rule, task.schedule.timezone)}
                      {task.schedule.rule.kind !== "manual"
                        ? ` · ${task.schedule.timezone}`
                        : ""}
                    </p>
                    {task.status === "active" && task.schedule.nextDueAt ? (
                      <p className="text-xs text-muted-foreground">
                        {t("list.nextRun", {
                          at: formatInstant(
                            task.schedule.nextDueAt,
                            task.schedule.timezone,
                          ),
                        })}
                      </p>
                    ) : null}
                    <TaskStatusReason task={task} />
                  </div>
                  <TaskMenu task={task} workspaceId={workspaceId} />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="inbox" className="mt-4">
          <div className="mb-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={unread === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              {t("inbox.markAllRead")}
            </Button>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <NotificationList workspaceId={workspaceId} limit={20} />
          </div>
        </TabsContent>
      </Tabs>

      <TaskFormDialog
        open={creating}
        onOpenChange={setCreating}
        workspaceId={workspaceId}
      />
    </div>
  );
}
