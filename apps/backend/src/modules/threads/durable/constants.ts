export {
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
  SOURCEWEFT_WEB_RUN_STOP_SUFFIX,
} from "@sourceweft/contracts";
import {
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
  SOURCEWEFT_WEB_RUN_STOP_SUFFIX,
} from "@sourceweft/contracts";

// The job name lives in modules/content/queue.ts, which is what actually
// enqueues; a second copy here had no readers and could only drift.
export const CHAT_RUN_STREAM_TTL_SECONDS = 24 * 60 * 60;

// Presence piggybacks the room SSE's existing 15s heartbeat as its TTL refresh
// (no separate client heartbeat). 40s ≈ 2.5 missed beats, so a single blip does
// not flicker a viewer out.
export const PRESENCE_TTL_SECONDS = 40;
export const PRESENCE_TTL_MS = PRESENCE_TTL_SECONDS * 1000;

export function isDurableChatRunKey(value: string | undefined) {
  return Boolean(value?.startsWith(SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX));
}

export function parseDurableChatRunKey(value: string | undefined) {
  if (!isDurableChatRunKey(value)) {
    return null;
  }

  if (value?.endsWith(SOURCEWEFT_WEB_RUN_STOP_SUFFIX)) {
    return {
      kind: "stop" as const,
      idempotencyKey: value.slice(0, -SOURCEWEFT_WEB_RUN_STOP_SUFFIX.length),
    };
  }

  return {
    kind: "run" as const,
    idempotencyKey: value as string,
  };
}
