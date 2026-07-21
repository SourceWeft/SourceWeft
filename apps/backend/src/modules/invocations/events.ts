import type { InvocationEvent } from "./types";

type InvocationEventInput = InvocationEvent extends infer Event
  ? Event extends InvocationEvent
    ? Omit<Event, "timestamp"> & { timestamp?: string }
    : never
  : never;

export function createInvocationEvent(
  input: InvocationEventInput,
): InvocationEvent {
  return {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
  } as InvocationEvent;
}
