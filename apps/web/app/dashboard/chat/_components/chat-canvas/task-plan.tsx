import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  ListChecks,
  Loader2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  QueueItem,
  QueueItemContent,
} from "@sourceweft/ui-web/components/ai-elements/queue";
import {
  Task,
  TaskContent,
  TaskTrigger,
} from "@sourceweft/ui-web/components/ai-elements/task";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import type { TaskPlan, TaskPlanTodoStatus } from "./task-plan-state";

function TaskPlanTodoIcon({
  isRunning,
  status,
}: {
  isRunning: boolean;
  status: TaskPlanTodoStatus;
}) {
  if (status === "completed") {
    return (
      <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
    );
  }
  if (status === "in_progress") {
    return isRunning ? (
      <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
    ) : (
      <CircleDot className="size-3.5 text-primary" />
    );
  }
  return <Circle className="size-3.5 text-muted-foreground/70" />;
}

/**
 * The run's `write_todos` plan. Later writes and the host's committed-delivery
 * closure replace the same step, so this renders once per message and updates
 * in place.
 */
export function TaskPlanCard({
  isRunning,
  plan,
}: {
  isRunning: boolean;
  plan: TaskPlan;
}) {
  const t = useTranslations("dashboardChatCanvas");
  const title = t("taskPlan.title");
  const total = plan.todos.length;
  const isWorking =
    isRunning && plan.todos.some((todo) => todo.status === "in_progress");

  return (
    <Task className="my-1.5 max-w-2xl text-sm" data-task-plan="true">
      <TaskTrigger title={title}>
        <button
          className={cn(
            ASSISTANT_ACTIVITY_ROW_CLASS,
            "cursor-pointer text-muted-foreground transition-colors hover:text-foreground",
          )}
          type="button"
        >
          <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
            {isWorking ? (
              <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
            ) : (
              <ListChecks className="size-3.5" />
            )}
          </span>
          <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
            <span className="truncate text-[13px] text-foreground/80">
              {title}
            </span>
            <span className="shrink-0 text-muted-foreground/70 text-xs">
              {t("taskPlan.progress", {
                completed: plan.completedCount,
                total,
              })}
            </span>
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/50 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </TaskTrigger>
      <TaskContent className="[&>div]:mt-1 [&>div]:ml-[10px] [&>div]:border-l [&>div]:pl-[13px]">
        <ul className="space-y-0.5">
          {plan.todos.map((todo, index) => {
            const completed = todo.status === "completed";
            return (
              <QueueItem
                className="flex-row items-start gap-2 px-1 py-0.5 hover:bg-transparent"
                data-todo-status={todo.status}
                key={`${index}:${todo.content}`}
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                  <TaskPlanTodoIcon
                    isRunning={isRunning}
                    status={todo.status}
                  />
                </span>
                <QueueItemContent
                  className={cn(
                    "line-clamp-none text-[13px] leading-5",
                    todo.status === "in_progress"
                      ? "text-foreground/85"
                      : undefined,
                  )}
                  completed={completed}
                >
                  <span className="sr-only">
                    {t(`taskPlan.status.${todo.status}`)}:{" "}
                  </span>
                  {todo.content}
                </QueueItemContent>
              </QueueItem>
            );
          })}
        </ul>
      </TaskContent>
    </Task>
  );
}
