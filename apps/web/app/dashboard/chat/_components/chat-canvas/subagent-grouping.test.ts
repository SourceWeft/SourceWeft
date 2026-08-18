import assert from "node:assert/strict";
import { test } from "vitest";
import {
  partitionWorkflowBlocksBySubagent,
  subagentDisplayName,
} from "./subagent-grouping";
import type { AssistantWorkflowBlock } from "./assistant-render-segments";
import type { ToolProducer } from "./types";

function toolBlock(id: string): AssistantWorkflowBlock {
  return { id, type: "tool", toolCallId: id };
}

function reasoningBlock(id: string): AssistantWorkflowBlock {
  return { id, type: "reasoning", text: "thinking" };
}

test("with no producers it is an identity transform (sub-graph streaming off)", () => {
  const blocks = [toolBlock("a"), reasoningBlock("r"), toolBlock("b")];
  const items = partitionWorkflowBlocksBySubagent(blocks, () => undefined);
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.kind === "block"));
});

test("a delegate's tool blocks collapse into one group at first appearance", () => {
  const producers: Record<string, ToolProducer> = {
    a: { kind: "subagent", taskCallId: "task1", subagentType: "explore" },
    b: { kind: "subagent", taskCallId: "task1", subagentType: "explore" },
  };
  const blocks = [toolBlock("a"), toolBlock("b")];
  const items = partitionWorkflowBlocksBySubagent(
    blocks,
    (block) => producers[block.id ?? ""],
  );
  assert.equal(items.length, 1);
  const group = items[0]!;
  assert.equal(group.kind, "agent-group");
  if (group.kind === "agent-group") {
    assert.equal(group.taskCallId, "task1");
    assert.equal(group.subagentType, "explore");
    assert.deepEqual(
      group.entries.map((entry) => entry.block.id),
      ["a", "b"],
    );
  }
});

test("parallel delegates interleaved on the stream group by id, not adjacency", () => {
  // Stream order: taskA, taskB, taskA, taskB → two groups, anchored at first hit.
  const producers: Record<string, ToolProducer> = {
    a1: { kind: "subagent", taskCallId: "A", subagentType: "explore" },
    b1: { kind: "subagent", taskCallId: "B", subagentType: "plan" },
    a2: { kind: "subagent", taskCallId: "A", subagentType: "explore" },
    b2: { kind: "subagent", taskCallId: "B", subagentType: "plan" },
  };
  const blocks = [
    toolBlock("a1"),
    toolBlock("b1"),
    toolBlock("a2"),
    toolBlock("b2"),
  ];
  const items = partitionWorkflowBlocksBySubagent(
    blocks,
    (block) => producers[block.id ?? ""],
  );
  assert.equal(items.length, 2);
  const [groupA, groupB] = items;
  assert.equal(groupA?.kind === "agent-group" && groupA.taskCallId, "A");
  assert.equal(groupB?.kind === "agent-group" && groupB.taskCallId, "B");
  if (groupA?.kind === "agent-group") {
    assert.deepEqual(
      groupA.entries.map((entry) => entry.block.id),
      ["a1", "a2"],
    );
    // Original indices are preserved for the running-state check.
    assert.deepEqual(
      groupA.entries.map((entry) => entry.index),
      [0, 2],
    );
  }
});

test("main-agent tool calls and reasoning stay ungrouped and in place", () => {
  const producers: Record<string, ToolProducer> = {
    sub: { kind: "subagent", taskCallId: "T", subagentType: "explore" },
  };
  const blocks = [
    toolBlock("main1"),
    reasoningBlock("r"),
    toolBlock("sub"),
    toolBlock("main2"),
  ];
  const items = partitionWorkflowBlocksBySubagent(
    blocks,
    (block) => producers[block.id ?? ""],
  );
  assert.deepEqual(
    items.map((item) => (item.kind === "block" ? item.block.id : "GROUP")),
    ["main1", "r", "GROUP", "main2"],
  );
});

test("subagentDisplayName humanizes the delegate type", () => {
  assert.equal(subagentDisplayName("general-purpose"), "General purpose");
  assert.equal(subagentDisplayName("explore"), "Explore");
  assert.equal(subagentDisplayName(undefined), "Sub-agent");
  assert.equal(subagentDisplayName("  "), "Sub-agent");
});
