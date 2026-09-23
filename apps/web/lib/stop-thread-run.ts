import { SOURCEWEFT_WEB_RUN_STOP_SUFFIX } from "@sourceweft/sdk";
import { apiBaseUrl } from "./api-base-url";

/** Cancel the selected durable run; never submit a replacement prompt. */
export function requestThreadRunStop(
  workspaceId: string,
  threadId: string,
  runKey: string,
) {
  return fetch(
    `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        idempotencyKey: `${runKey}${SOURCEWEFT_WEB_RUN_STOP_SUFFIX}`,
        stream: false,
      }),
    },
  );
}
