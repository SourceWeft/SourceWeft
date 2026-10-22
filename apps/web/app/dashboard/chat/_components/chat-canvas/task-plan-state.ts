import type { ThinkingStepRecord } from "./types";

/**
 * The backend upserts every `write_todos` call, and the host's
 * committed-delivery closure, into this one thinking step. Its id and
 * sequence stay fixed for the run, so one message has at most one plan.
 */
export const TASK_PLAN_STEP_ID = "deepagents:todos";

export type TaskPlanTodoStatus = "pending" | "in_progress" | "completed";

export type TaskPlanTodo = {
  content: string;
  status: TaskPlanTodoStatus;
};

export type TaskPlan = {
  closedBy?: string;
  completedCount: number;
  todos: TaskPlanTodo[];
};

function isTaskPlanTodoStatus(value: unknown): value is TaskPlanTodoStatus {
  return (
    value === "pending" || value === "in_progress" || value === "completed"
  );
}

function parseTaskPlanTodos(value: unknown): TaskPlanTodo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TaskPlanTodo[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const content =
      typeof record.content === "string" ? record.content.trim() : "";
    if (!content || !isTaskPlanTodoStatus(record.status)) return [];
    return [{ content, status: record.status }];
  });
}

/**
 * Reads each todo's own status from `metadata.todos`. The step's status is
 * not used: the web terminalizes an in-progress step when a run ends, which
 * says nothing about the individual todos.
 */
export function resolveTaskPlan(
  steps: readonly ThinkingStepRecord[] | undefined,
): TaskPlan | null {
  const step = steps?.find((candidate) => candidate.id === TASK_PLAN_STEP_ID);
  const todos = parseTaskPlanTodos(step?.metadata?.todos);
  if (todos.length === 0) return null;
  const closedBy = step?.metadata?.closedBy;
  return {
    ...(typeof closedBy === "string" ? { closedBy } : {}),
    completedCount: todos.filter((todo) => todo.status === "completed").length,
    todos,
  };
}

export function taskPlanSignature(plan: TaskPlan | null) {
  if (!plan) return "";
  return [
    plan.closedBy ?? "",
    ...plan.todos.map((todo) => `${todo.status}:${todo.content}`),
  ].join("\n");
}
