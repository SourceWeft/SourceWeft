import { config } from "../../../../shared/config";

/**
 * Whether to EXPOSE the async sub-agent tools to the model (API process).
 *
 * Fail-closed on BOTH the enable flag and the internal token: the agent runs in
 * the API process and calls the endpoint through the token guard, so without the
 * token every `start_async_task` would be rejected — handing the model the tools
 * would only produce runtime failures. The endpoint mount is gated the same way
 * (`mountInternalAsyncRuns`).
 *
 * NOTE: this is an API-side predicate. The WORKER gates on the enable flag ALONE
 * (`config.chat.agent.asyncSubagentsEnabled`) — it neither serves nor calls the
 * endpoint, so it needs neither the token nor the URL.
 */
export function asyncSubagentsExposed(): boolean {
  return (
    config.chat.agent.asyncSubagentsEnabled &&
    config.chat.agent.asyncRunsInternalToken.length > 0
  );
}
