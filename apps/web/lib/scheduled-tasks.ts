"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CreateAgentTaskRequest,
  UpdateAgentTaskRequest,
} from "@sourceweft/contracts/scheduled-tasks";
import { HttpClientError } from "@sourceweft/sdk";
import { agentTasksClient, notificationsClient } from "./sdk";

/** Every key carries the workspace, so switching workspaces never shows another's tasks. */
export const scheduledKeys = {
  all: (workspaceId: string | null) => ["scheduled", workspaceId] as const,
  tasks: (workspaceId: string | null) =>
    ["scheduled", workspaceId, "tasks"] as const,
  task: (workspaceId: string | null, taskId: string) =>
    ["scheduled", workspaceId, "task", taskId] as const,
  runs: (workspaceId: string | null, taskId: string) =>
    ["scheduled", workspaceId, "runs", taskId] as const,
  inbox: (workspaceId: string | null) =>
    ["scheduled", workspaceId, "inbox"] as const,
  unread: (workspaceId: string | null) =>
    ["scheduled", workspaceId, "unread"] as const,
};

/** The refusal's stable code (`AGENT_TASK_LIMIT_REACHED`, ...), if it has one. */
export function agentTaskErrorCode(error: unknown) {
  return error instanceof HttpClientError ? error.code : null;
}

export function useAgentTasks(workspaceId: string | null) {
  return useQuery({
    queryKey: scheduledKeys.tasks(workspaceId),
    queryFn: () => agentTasksClient.list(workspaceId!),
    enabled: Boolean(workspaceId),
    select: (data) => data.tasks,
  });
}

export function useAgentTask(workspaceId: string | null, taskId: string) {
  return useQuery({
    queryKey: scheduledKeys.task(workspaceId, taskId),
    queryFn: () => agentTasksClient.get(workspaceId!, taskId),
    enabled: Boolean(workspaceId),
    select: (data) => data.task,
    retry: false,
  });
}

export function useAgentTaskRuns(workspaceId: string | null, taskId: string) {
  return useInfiniteQuery({
    queryKey: scheduledKeys.runs(workspaceId, taskId),
    queryFn: ({ pageParam }) =>
      agentTasksClient.listRuns(workspaceId!, taskId, {
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
    // A run that is still going finishes on its own.
    refetchInterval: (query) =>
      query.state.data?.pages
        .flatMap((page) => page.runs)
        .some((run) =>
          ["pending", "dispatching", "queued"].includes(run.status),
        )
        ? 5_000
        : false,
  });
}

/** Every task action refreshes the list, the task and its runs. */
export function useAgentTaskMutations(workspaceId: string | null) {
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: scheduledKeys.all(workspaceId) });
  const need = () => {
    if (!workspaceId) throw new Error("No workspace is selected");
    return workspaceId;
  };
  const useAction = <Input, Output>(run: (input: Input) => Promise<Output>) =>
    useMutation({ mutationFn: run, onSettled: refresh });

  return {
    create: useAction((input: CreateAgentTaskRequest) =>
      agentTasksClient.create(need(), input),
    ),
    update: useAction(
      (input: { taskId: string; changes: UpdateAgentTaskRequest }) =>
        agentTasksClient.update(need(), input.taskId, input.changes),
    ),
    remove: useAction((taskId: string) =>
      agentTasksClient.delete(need(), taskId),
    ),
    pause: useAction((taskId: string) =>
      agentTasksClient.pause(need(), taskId),
    ),
    resume: useAction((taskId: string) =>
      agentTasksClient.resume(need(), taskId),
    ),
    activate: useAction((taskId: string) =>
      agentTasksClient.activate(need(), taskId),
    ),
    runNow: useAction((taskId: string) =>
      agentTasksClient.runNow(need(), taskId, {
        // One key per click: a double click starts one run.
        idempotencyKey: crypto.randomUUID(),
      }),
    ),
  };
}

export function useUnreadNotificationCount(workspaceId: string | null) {
  return useQuery({
    queryKey: scheduledKeys.unread(workspaceId),
    queryFn: () => notificationsClient.unreadCount(workspaceId!),
    enabled: Boolean(workspaceId),
    select: (data) => data.count,
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
  });
}

export function useNotifications(workspaceId: string | null, limit = 20) {
  return useInfiniteQuery({
    queryKey: [...scheduledKeys.inbox(workspaceId), limit],
    queryFn: ({ pageParam }) =>
      notificationsClient.list(workspaceId!, {
        limit,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
  });
}

export function useNotificationMutations(workspaceId: string | null) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({
      queryKey: scheduledKeys.inbox(workspaceId),
    });
    void client.invalidateQueries({
      queryKey: scheduledKeys.unread(workspaceId),
    });
  };
  return {
    markRead: useMutation({
      mutationFn: (id: string) =>
        notificationsClient.markRead(workspaceId!, id),
      onSettled: refresh,
    }),
    markAllRead: useMutation({
      mutationFn: () => notificationsClient.markAllRead(workspaceId!),
      onSettled: refresh,
    }),
  };
}
