/**
 * Regression guard for sub-agent (subgraph) HITL correlation.
 *
 * When a subagent raises a human-in-the-loop interrupt, its tool-call id lives
 * in the child subgraph and never surfaces in the top-level graph — so binding
 * the confirmation to a checkpoint tool-call id (the old approach) could not
 * match it. {@link hitlActionRef} fixes this by deriving a stable key purely
 * from the interrupt payload (`interruptId`/`checkpointId`, action `index`,
 * `toolName`) and never reading graph state.
 *
 * These tests lock in the three properties the fix depends on:
 *  1. Stable across the approve→resume round trip (same inputs → same ref).
 *  2. Payload-derived only — the signature cannot take a graph/tool-call id, so
 *     a subgraph interrupt binds the same way a top-level one does.
 *  3. Collision-free across actions, tools, and concurrent subagents.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { hitlActionRef } from "./hitl-action-ref";

test("hitlActionRef is stable across the approve→resume round trip", () => {
  const input = {
    checkpointId: "ckpt_1",
    interruptId: "int_1",
    index: 0,
    toolName: "write_file",
  };

  // The same interrupt re-fires at the same checkpoint on resume — the ref must
  // be byte-identical so the decision routes back to the right action.
  assert.equal(hitlActionRef(input), hitlActionRef({ ...input }));
});

test("hitlActionRef prefers the interruptId, falling back to the checkpointId", () => {
  const withInterrupt = hitlActionRef({
    checkpointId: "ckpt_1",
    interruptId: "int_9",
    index: 0,
    toolName: "bash",
  });
  const withoutInterrupt = hitlActionRef({
    checkpointId: "ckpt_1",
    index: 0,
    toolName: "bash",
  });

  assert.match(withInterrupt, /:int_9:/);
  assert.match(withoutInterrupt, /:ckpt_1:/);
  assert.notEqual(withInterrupt, withoutInterrupt);
});

test("hitlActionRef binds a subagent interrupt without any top-level tool-call id", () => {
  // A subagent interrupt carries its own interruptId but no top-level tool-call
  // id. The ref is computed from payload alone — proving graph state is never
  // needed to correlate a subgraph interrupt.
  const subagentRef = hitlActionRef({
    checkpointId: "ckpt_parent",
    interruptId: "subagent_interrupt_abc",
    index: 0,
    toolName: "publish_artifact",
  });

  assert.equal(subagentRef, "hitl:subagent_interrupt_abc:0:publish_artifact");
});

test("hitlActionRef never collides across actions, tools, or concurrent subagents", () => {
  const base = {
    checkpointId: "ckpt_1",
    interruptId: "int_1",
    index: 0,
    toolName: "write_file",
  };

  const refs = new Set([
    hitlActionRef(base),
    // second action in the same interrupt
    hitlActionRef({ ...base, index: 1 }),
    // different tool in the same interrupt
    hitlActionRef({ ...base, toolName: "bash" }),
    // a concurrent subagent's own interrupt at the same checkpoint
    hitlActionRef({ ...base, interruptId: "int_2" }),
  ]);

  // All four are distinct — no action, tool, or sibling subagent shadows another.
  assert.equal(refs.size, 4);
});
