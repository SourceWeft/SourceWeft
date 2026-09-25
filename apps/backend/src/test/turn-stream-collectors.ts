import { handleCustomStreamChunk } from "../modules/threads/agent/turn/custom-stream-handler";
import type { DeepAgentTurnEvent } from "../modules/threads/agent/turn/events";
import {
  handleHitlStreamChunk,
  type HitlStreamHandlerResult,
} from "../modules/threads/agent/turn/hitl-stream-handler";
import { handleMessagesStreamChunk } from "../modules/threads/agent/turn/message-stream-handler";
import { createPreparedThreadTurn } from "./prepared-turn";

/**
 * Drains one agent-turn stream handler into an array of the events it yields.
 * The message/custom/tool variants are the same loop with different input
 * types; the HITL variant also surfaces the generator's return value, which
 * is how the HITL handler reports continue / done / replace-stream.
 */
export async function collectMessageStreamEvents(
  input: Parameters<typeof handleMessagesStreamChunk>[0],
) {
  const events: DeepAgentTurnEvent[] = [];
  for await (const event of handleMessagesStreamChunk(input)) {
    events.push(event);
  }
  return events;
}

export async function collectCustomStreamEvents(
  input: Parameters<typeof handleCustomStreamChunk>[0],
) {
  const events: DeepAgentTurnEvent[] = [];
  for await (const event of handleCustomStreamChunk(input)) {
    events.push(event);
  }
  return events;
}

export async function collectHitlStreamResult(
  input: Parameters<typeof handleHitlStreamChunk>[0],
) {
  const events: DeepAgentTurnEvent[] = [];
  const generator = handleHitlStreamChunk(input);
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return {
        events,
        result: next.value as HitlStreamHandlerResult,
      };
    }
    events.push(next.value);
  }
}

export async function collectToolStreamEvents(
  generator: AsyncGenerator<DeepAgentTurnEvent>,
) {
  const events: DeepAgentTurnEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

/** The prepared turn the tool-stream-handler tests drive their runtime from. */
export function createToolLoggingPreparedTurn() {
  return createPreparedThreadTurn({
    runTraceId: "trace-tool-logging",
    thread: { id: "thread-1" },
    userMessage: { id: "message-1" },
    workspace: { id: "workspace-1", organizationId: "team-1" },
    userId: "user-1",
  });
}
