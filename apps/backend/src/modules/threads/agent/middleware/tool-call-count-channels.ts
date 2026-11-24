import { createMiddleware } from "langchain";
import { z } from "zod/v4";

/**
 * Declare langchain `toolCallLimitMiddleware`'s two count channels on every
 * agent, whether or not a limiter is mounted in its stack.
 *
 * Two things need the channels to exist:
 *
 * - the step budget clears `runToolCallCount` when a new user message starts
 *   (step-budget `beforeAgent`), also on stacks with no limiter at all;
 * - checkpoints written while a limiter was mounted still hold both keys.
 *
 * Until deepagents 1.13.3 this middleware also had to swap in a merging
 * reducer: each `task` delegate returned its counts to the parent, so two
 * delegates in one model step wrote the parent's last-value channel twice and
 * the turn failed. deepagents 1.13.4 keeps call counts on each side of the
 * subagent boundary (parallel-task-call-counts.test.ts runs the installed SDK
 * with no override), so the channels are plain last-value records again, the
 * way langchain declares them.
 *
 * The zod-level default is required: langchain's `initializeMiddlewareStates`
 * (>=1.5) zod-parses each middleware stateSchema at invoke time and rejects a
 * required public field with "has required state fields that must be
 * initialized". The default only seeds a brand-new thread; on resume the
 * checkpointed count already occupies the key and is preserved.
 */
function countChannel() {
  return z.record(z.string(), z.number()).default(() => ({}));
}

export function createSourceWeftToolCallCountChannelsMiddleware() {
  return createMiddleware({
    name: "SourceWeftToolCallCountChannels",
    stateSchema: z.object({
      threadToolCallCount: countChannel(),
      runToolCallCount: countChannel(),
    }),
  });
}
