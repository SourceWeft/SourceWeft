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

test("children fold into the parent `task` delegate block, anchored at it", () => {
  // Stream: parent `task` block, then its two child tool blocks.
  const producers: Record<string, ToolProducer> = {
    c1: { kind: "subagent", taskCallId: "task1", subagentType: "general-purpose" },
    c2: { kind: "subagent", taskCallId: "task1", subagentType: "general-purpose" },
  };
  const blocks = [toolBlock("task1"), toolBlock("c1"), toolBlock("c2")];
  const items = partitionWorkflowBlocksBySubagent(
    blocks,
    (block) => producers[block.id ?? ""],
    (block) => (block.id === "task1" ? { taskCallId: "task1" } : undefined),
  );
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.kind, "delegate");
  if (item.kind === "delegate") {
    assert.equal(item.taskCallId, "task1");
    assert.equal(item.taskBlock.block.id, "task1");
    assert.equal(item.subagentType, "general-purpose");
    assert.deepEqual(
      item.entries.map((entry) => entry.block.id),
      ["c1", "c2"],
    );
    // Child original indices preserved for the running-state check.
    assert.deepEqual(
      item.entries.map((entry) => entry.index),
      [1, 2],
    );
  }
});

test("delegate item anchors at the parent even when children stream first", () => {
  const producers: Record<string, ToolProducer> = {
    c1: { kind: "subagent", taskCallId: "T", subagentType: "explore" },
  };
  // Child appears before the parent `task` block on the stream.
  const blocks = [toolBlock("c1"), toolBlock("T")];
  const items = partitionWorkflowBlocksBySubagent(
    blocks,
    (block) => producers[block.id ?? ""],
    (block) => (block.id === "T" ? { taskCallId: "T" } : undefined),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "delegate");
  if (items[0]?.kind === "delegate") {
    assert.equal(items[0].taskBlock.index, 1);
    assert.deepEqual(
      items[0].entries.map((entry) => entry.block.id),
      ["c1"],
    );
  }
});

test("parallel delegates each fold under their own parent block", () => {
  const producers: Record<string, ToolProducer> = {
    a1: { kind: "subagent", taskCallId: "A", subagentType: "general-purpose" },
    b1: { kind: "subagent", taskCallId: "B", subagentType: "general-purpose" },
  };
  const delegateIds: Record<string, string> = { A: "A", B: "B" };
  const blocks = [
    toolBlock("A"),
    toolBlock("B"),
    toolBlock("a1"),
    toolBlock("b1"),
  ];
  const items = partitionWorkflowBlocksBySubagent(
    blocks,
    (block) => producers[block.id ?? ""],
    (block) =>
      delegateIds[block.id ?? ""]
        ? { taskCallId: delegateIds[block.id ?? ""]! }
        : undefined,
  );
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => (item.kind === "delegate" ? item.taskCallId : "?")),
    ["A", "B"],
  );
});

test("a delegate parent with no streamed children still emits an empty box", () => {
  // Sub-graph streaming off / children elsewhere: parent present, no producers.
  const blocks = [toolBlock("task1")];
  const items = partitionWorkflowBlocksBySubagent(
    blocks,
    () => undefined,
    (block) => (block.id === "task1" ? { taskCallId: "task1" } : undefined),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "delegate");
  if (items[0]?.kind === "delegate") {
    assert.equal(items[0].entries.length, 0);
  }
});

test("orphan children (parent not in segment) still fall back to a group", () => {
  const producers: Record<string, ToolProducer> = {
    c1: { kind: "subagent", taskCallId: "gone", subagentType: "explore" },
  };
  const blocks = [toolBlock("c1")];
  // resolveDelegate provided, but no parent block matches "gone".
  const items = partitionWorkflowBlocksBySubagent(
    blocks,
    (block) => producers[block.id ?? ""],
    () => undefined,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "agent-group");
});

test("subagentDisplayName humanizes the delegate type", () => {
  assert.equal(subagentDisplayName("general-purpose"), "General purpose");
  assert.equal(subagentDisplayName("explore"), "Explore");
  assert.equal(subagentDisplayName(undefined), "Sub-agent");
  assert.equal(subagentDisplayName("  "), "Sub-agent");
});
