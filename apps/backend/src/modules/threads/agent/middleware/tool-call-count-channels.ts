import { createMiddleware } from "langchain";
import { withLangGraph } from "@langchain/langgraph/zod";
import { z } from "zod/v4";

/**
 * Merge two tool-call-count records so the underlying channel tolerates more
 * than one write per superstep.
 *
 * `toolCallLimitMiddleware` tracks counts in `{ [countKey]: number }` records
 * and returns the full record from its `afterModel` hook. When the model issues
 * several `task` calls at once, the ToolNode runs the subagents in parallel and
 * returns one `Command` per subagent (see langchain `ToolNode.run`). Each
 * subagent graph carries the same middleware, so every Command writes these
 * channels in the same step. LangChain's built-in schema declares them with the
 * default `LastValue` channel, which rejects concurrent writes with
 * "LastValue can only receive one value per step" and fails the whole turn.
 *
 * Counts are monotonic per key, so an element-wise max merges the concurrent
 * subagent writes without under-counting. An empty update is preserved as a
 * reset so `toolCallLimitMiddleware`'s `afterAgent` run-count reset (which emits
 * `{}`) keeps working.
 */
type ToolCallCounts = Record<string, number>;

export function mergeToolCallCounts(
  current: ToolCallCounts | undefined,
  update: ToolCallCounts | undefined,
): ToolCallCounts {
  if (!update || Object.keys(update).length === 0) {
    return {};
  }
  const merged: Record<string, number> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return merged;
}

function countChannel() {
  // The zod-level `.default(() => ({}))` is required in addition to the channel
  // `default` below. langchain's `initializeMiddlewareStates` (>=1.5) zod-parses
  // each middleware stateSchema at invoke time to check every public field is
  // initialisable, and it honours ONLY a zod-level default/optional — not the
  // `withLangGraph` channel default. Without it the parse rejects
  // `threadToolCallCount` / `runToolCallCount` as required and the whole turn
  // fails with "has required state fields that must be initialized". The
  // injected default only seeds a brand-new thread; on resume the checkpointed
  // count already occupies the key and is preserved (see ReactAgent
  // #initializeMiddlewareStates: it merges getState().values first and only
  // fills keys that are absent).
  const base = z.record(z.string(), z.number());
  // `withLangGraph` registers reducer metadata against (and returns) the exact
  // object it is handed, so the `.default()` wrapper — not the bare record —
  // must be the value that lands in the state object and later resolves in the
  // registry. Its interop typing lacks the surface `withLangGraph` expects, so
  // present it to the compiler as the underlying record; the runtime object is
  // still the defaulted schema.
  const withDefault = base.default((): ToolCallCounts => ({}));
  return withLangGraph(withDefault as unknown as typeof base, {
    reducer: {
      fn: (current: ToolCallCounts, update: ToolCallCounts): ToolCallCounts =>
        mergeToolCallCounts(current, update),
    },
    default: (): ToolCallCounts => ({}),
  });
}

/**
 * Redeclare `toolCallLimitMiddleware`'s count channels with a concurrent-safe
 * reducer.
 *
 * `createAgentState` binds each state channel to the FIRST middleware that
 * declares its key and only honours a reducer when the field is a zod v4 schema
 * (LangChain's built-in declares these with zod v3, i.e. plain `LastValue`).
 * Placing this middleware ahead of every `toolCallLimitMiddleware` in the stack
 * therefore wins the `threadToolCallCount` / `runToolCallCount` channels and
 * swaps their reducer, without reimplementing the limit logic itself.
 */
export function createSourceWeftToolCallCountChannelsMiddleware() {
  return createMiddleware({
    name: "SourceWeftToolCallCountChannels",
    stateSchema: z.object({
      threadToolCallCount: countChannel(),
      runToolCallCount: countChannel(),
    }),
  });
}
