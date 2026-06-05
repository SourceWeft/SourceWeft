import type { InvocationEvent, InvocationEventType } from "./types";

type InvocationEventInput = InvocationEvent extends infer Event
  ? Event extends InvocationEvent
    ? Omit<Event, "timestamp"> & { timestamp?: string }
    : never
  : never;

export const INVOCATION_EVENT_TYPES: InvocationEventType[] = [
  "resolve",
  "policy",
  "approval_required",
  "tool_choice_bound",
  "context_injected",
  "direct_execute",
  "deepagents_handoff",
  "result",
  "error",
];

export function createInvocationEvent(
  input: InvocationEventInput,
): InvocationEvent {
  return {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
  } as InvocationEvent;
}
