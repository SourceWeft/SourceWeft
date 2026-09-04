import assert from "node:assert/strict";
import { test } from "vitest";
import { resolvePendingInterruptCheckpoint } from "./checkpoint";
import type { AgentRunnableConfig } from "./checkpoint";

type StateCall = { configurable?: Record<string, unknown> };

/**
 * An agent whose `getState` answers per checkpoint: the thread head has a
 * pending `tools` task (an interrupt was just raised), while the checkpoint a
 * `continue` turn forks from — the PREVIOUS assistant turn's final checkpoint —
 * finished long ago and has nothing pending.
 */
function agentWithHeadInterrupt(calls: StateCall[]) {
  return {
    getState: async (config: StateCall) => {
      calls.push(config);
      const pinned = config.configurable?.checkpoint_id;
      if (typeof pinned === "string") {
        return {
          next: [],
          config: {
            configurable: { thread_id: "thread-1", checkpoint_id: pinned },
          },
        };
      }
      return {
        next: ["tools"],
        config: {
          configurable: { thread_id: "thread-1", checkpoint_id: "head" },
        },
      };
    },
  } as unknown as Parameters<
    typeof resolvePendingInterruptCheckpoint
  >[0]["agent"];
}

test("a pending interrupt is read from the head, not the turn's pinned base", async () => {
  // The regression: a `continue` turn pins `checkpoint_id` to the previous
  // assistant turn's final checkpoint, but the interrupt this turn raised lives
  // at the head. Reading the pin reported "nothing pending", so every tool
  // approval after the first one in a thread failed with
  // AGENT_HITL_TOOL_CALL_NOT_FOUND.
  const calls: StateCall[] = [];
  const result = await resolvePendingInterruptCheckpoint({
    agent: agentWithHeadInterrupt(calls),
    config: {
      configurable: {
        thread_id: "thread-1",
        checkpoint_id: "previous-turn-final",
        checkpoint_ns: "",
      },
    } as unknown as AgentRunnableConfig,
  });

  assert.equal(result.pending, true);
  assert.equal(result.checkpoint?.checkpointId, "head");
  // The pin is dropped, the namespace is not — a subgraph's head is not the
  // root graph's.
  assert.equal(calls[0]?.configurable?.checkpoint_id, undefined);
  assert.equal(calls[0]?.configurable?.checkpoint_ns, "");
  assert.equal(calls[0]?.configurable?.thread_id, "thread-1");
});

test("an unpinned config is passed through untouched", async () => {
  const calls: StateCall[] = [];
  const config = {
    configurable: { thread_id: "thread-1" },
  } as unknown as AgentRunnableConfig;
  const result = await resolvePendingInterruptCheckpoint({
    agent: agentWithHeadInterrupt(calls),
    config,
  });

  assert.equal(result.pending, true);
  assert.equal(calls[0], config);
});
