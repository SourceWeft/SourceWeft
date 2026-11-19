"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { AgentTask } from "@sourceweft/contracts/scheduled-tasks";
import {
  agentTaskErrorCode,
  useAgentTaskMutations,
} from "../../../../lib/scheduled-tasks";

/**
 * What a person can do with a task, with one toast wording for every refusal.
 * Shared by the list rows and the detail page.
 */
export function useTaskActions(workspaceId: string | null) {
  const t = useTranslations("dashboardScheduled");
  const mutations = useAgentTaskMutations(workspaceId);

  const fail = React.useCallback(
    (error: unknown) => {
      const code = agentTaskErrorCode(error);
      const known = [
        "AGENT_TASK_LIMIT_REACHED",
        "AGENT_TASK_RUN_RATE_LIMITED",
        "AGENT_TASK_RUN_CONFLICT",
        "AGENT_TASK_INVALID_STATE",
        "AGENT_TASK_VERSION_CONFLICT",
        "AGENT_TASK_NOT_FOUND",
      ];
      toast.error(
        code && known.includes(code)
          ? t(`errors.${code}`)
          : t("errors.generic"),
      );
    },
    [t],
  );

  const run = React.useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      try {
        await action();
        toast.success(success);
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    [fail],
  );

  return {
    fail,
    runNow: (task: AgentTask) =>
      run(() => mutations.runNow.mutateAsync(task.id), t("toasts.runStarted")),
    pause: (task: AgentTask) =>
      run(() => mutations.pause.mutateAsync(task.id), t("toasts.paused")),
    resume: (task: AgentTask) =>
      run(() => mutations.resume.mutateAsync(task.id), t("toasts.resumed")),
    activate: (task: AgentTask) =>
      run(() => mutations.activate.mutateAsync(task.id), t("toasts.enabled")),
    remove: (task: AgentTask) =>
      run(() => mutations.remove.mutateAsync(task.id), t("toasts.deleted")),
  };
}
