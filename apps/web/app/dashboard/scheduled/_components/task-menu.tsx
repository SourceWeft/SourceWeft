"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { MoreHorizontal } from "lucide-react";
import type { AgentTask } from "@sourceweft/contracts/scheduled-tasks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sourceweft/ui-web/components/ui/alert-dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { TaskFormDialog } from "./task-form-dialog";
import { useTaskActions } from "./task-actions";

/**
 * The actions of one task: run now, pause or enable, edit, delete. The list
 * rows and the detail page share it, so both offer the same set in the same
 * states.
 */
export function TaskMenu({
  task,
  workspaceId,
  onDeleted,
}: {
  task: AgentTask;
  workspaceId: string | null;
  onDeleted?: () => void;
}) {
  const t = useTranslations("dashboardScheduled");
  const actions = useTaskActions(workspaceId);
  const [editing, setEditing] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  const canRun = task.status !== "archived";
  const canPause = task.status === "active";
  const canResume = task.status === "paused" || task.status === "blocked";
  const canActivate =
    (task.status === "draft" || task.status === "completed") &&
    task.schedule.rule.kind !== "manual";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("actions.open", { name: task.name })}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canRun ? (
            <DropdownMenuItem onSelect={() => void actions.runNow(task)}>
              {t("actions.runNow")}
            </DropdownMenuItem>
          ) : null}
          {canPause ? (
            <DropdownMenuItem onSelect={() => void actions.pause(task)}>
              {t("actions.pause")}
            </DropdownMenuItem>
          ) : null}
          {canResume ? (
            <DropdownMenuItem onSelect={() => void actions.resume(task)}>
              {t("actions.resume")}
            </DropdownMenuItem>
          ) : null}
          {canActivate ? (
            <DropdownMenuItem onSelect={() => void actions.activate(task)}>
              {t("actions.enable")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            {t("actions.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => setConfirming(true)}
          >
            {t("actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <TaskFormDialog
        open={editing}
        onOpenChange={setEditing}
        workspaceId={workspaceId}
        task={task}
      />

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("delete.title", { name: task.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("delete.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("form.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (await actions.remove(task)) onDeleted?.();
              }}
            >
              {t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
