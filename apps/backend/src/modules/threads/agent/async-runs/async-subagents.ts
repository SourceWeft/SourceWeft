/**
 * The async (background) delegates exposed to the model through deepagents'
 * async task tools. Passing these in `createDeepAgent`'s `subagents` array is
 * enough — deepagents detects them by `graphId` and wires
 * `createAsyncSubAgentMiddleware` automatically, so `check_async_task` /
 * `list_async_tasks` / `update_async_task` / `cancel_async_task` appear and drive
 * our self-hosted runs endpoint at `url`.
 *
 * `graphId` matches a delegate compiled by `delegate-graph.ts`; `url` is our
 * internal Agent-Protocol endpoint base.
 */
import type { AsyncSubAgent } from "deepagents";
import { DELEGATE_GRAPH_IDS } from "./delegate-graph";

export function buildAsyncDelegates(endpointBaseUrl: string): AsyncSubAgent[] {
  return DELEGATE_GRAPH_IDS.map((graphId) => ({
    name: `${graphId}-async`,
    description:
      `Background ${graphId} delegate — same read-only ${graphId} work, but ` +
      `run in the background: it returns a task id immediately and you check its ` +
      `status/result, send follow-up instructions, or cancel it with the async ` +
      `task tools. Use it for long or parallel investigations; use the plain ` +
      `\`task\` tool when you can wait for the result inline.`,
    graphId,
    url: endpointBaseUrl,
  }));
}
