"use client";

import { useTranslations } from "next-intl";
import type {
  AgentTask,
  AgentTaskRun,
} from "@sourceweft/contracts/scheduled-tasks";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";

const TASK_VARIANT = {
  draft: "outline",
  active: "default",
  paused: "secondary",
  blocked: "destructive",
  completed: "secondary",
  archived: "outline",
} as const;

export function TaskStatusBadge({ task }: { task: AgentTask }) {
  const t = useTranslations("dashboardScheduled");
  return (
    <Badge variant={TASK_VARIANT[task.status]}>
      {t(`status.${task.status}`)}
    </Badge>
  );
}

/** Why a task is not running, when something other than the owner stopped it. */
export function TaskStatusReason({ task }: { task: AgentTask }) {
  const t = useTranslations("dashboardScheduled");
  if (!task.statusReason || task.statusReason === "user_paused") return null;
  return (
    <p className="text-xs text-destructive" role="status">
      {t(`statusReason.${task.statusReason}`)}
    </p>
  );
}

const RUN_VARIANT = {
  pending: "outline",
  dispatching: "outline",
  queued: "outline",
  succeeded: "default",
  failed: "destructive",
  skipped: "secondary",
  blocked: "destructive",
  cancelled: "secondary",
} as const;

export function RunStatusBadge({ run }: { run: AgentTaskRun }) {
  const t = useTranslations("dashboardScheduled");
  return (
    <Badge variant={RUN_VARIANT[run.status]}>
      {t(`runStatus.${run.status}`)}
    </Badge>
  );
}
