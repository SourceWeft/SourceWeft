import type { ThinkingStepRecord } from "./types";

export type TodoListTraceItem = {
  content: string;
  description?: string;
  id: string;
  status: "pending" | "in_progress" | "completed";
};

function getRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  return record ? record[key] : undefined;
}

export function isTodoListTraceStep(step: ThinkingStepRecord) {
  return (
    step.metadata?.display === "todo_list" &&
    step.metadata.visibility === "user"
  );
}

function normalizeTodoStatus(value: unknown): TodoListTraceItem["status"] {
  return value === "completed" || value === "in_progress"
    ? value
    : "pending";
}

export function getTodoListTraceItems(
  metadata: Record<string, unknown> | undefined,
) {
  const todos = getRecordValue(metadata, "todos");
  if (!Array.isArray(todos)) {
    return [] as TodoListTraceItem[];
  }

  return todos
    .map((item, index): TodoListTraceItem | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const content =
        typeof record.content === "string"
          ? record.content.trim()
          : typeof record.title === "string"
            ? record.title.trim()
            : "";
      if (!content) {
        return null;
      }
      const id =
        typeof record.id === "string" && record.id.trim()
          ? record.id.trim()
          : `${index}:${content}`;
      const description =
        typeof record.description === "string" && record.description.trim()
          ? record.description.trim()
          : undefined;
      return {
        content,
        id,
        status: normalizeTodoStatus(record.status),
        ...(description ? { description } : {}),
      };
    })
    .filter((item): item is TodoListTraceItem => item !== null);
}
