export {
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
  SOURCEWEFT_WEB_RUN_STOP_SUFFIX,
} from "@sourceweft/contracts";
import {
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
  SOURCEWEFT_WEB_RUN_STOP_SUFFIX,
} from "@sourceweft/contracts";

export const THREAD_CHAT_RUN_JOB = "thread-chat-run";
export const CHAT_RUN_STREAM_TTL_SECONDS = 24 * 60 * 60;

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
