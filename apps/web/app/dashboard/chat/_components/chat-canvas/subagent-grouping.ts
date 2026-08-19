import type { AssistantWorkflowBlock } from "./assistant-render-segments";
import type { ToolProducer } from "./types";

/** A block paired with its original index within the workflow segment. */
export type WorkflowBlockEntry = {
  block: AssistantWorkflowBlock;
  index: number;
};

/**
 * One rendered unit inside a workflow segment:
 * - `block`: a standalone block (the main agent's tool call, reasoning, etc.).
 * - `delegate`: one `task` delegation — the parent `task` tool block paired with
 *   its sub-agent's nested tool blocks, rendered together in a single Agent card
 *   (header/brief/steps/report). This is the normal shape once we can identify
 *   the parent `task` call.
 * - `agent-group`: fallback for a delegate's tool blocks whose parent `task`
 *   block isn't in this segment (or when no delegate resolver is supplied, e.g.
 *   sub-graph streaming off) — grouped on their own, headerless-parent.
 */
export type WorkflowRenderItem =
  | { kind: "block"; block: AssistantWorkflowBlock; index: number }
  | {
      kind: "delegate";
      key: string;
      taskCallId: string;
      taskBlock: WorkflowBlockEntry;
      subagentType?: string;
      entries: WorkflowBlockEntry[];
    }
  | {
      kind: "agent-group";
      key: string;
      taskCallId: string;
      subagentType?: string;
      entries: WorkflowBlockEntry[];
    };

/** Identifies a `task` delegation's parent tool block and its call id. */
export type DelegateBlockInfo = { taskCallId: string };

/**
 * Partition a workflow segment's blocks so every sub-agent's tool calls collapse
 * under its parent `task` delegation, keyed by the parent `task` call id.
 *
 * Grouping is by id, not adjacency: parallel delegates interleave their tool
 * events on the stream, so a delegate's blocks are gathered wherever they land.
 * When `resolveDelegate` can identify the parent `task` tool block, the group is
 * folded into it as a `delegate` item anchored at the parent block's position
 * (that's where the delegation happens) — this is what lets the UI render one
 * Agent card per delegate instead of a separate "Delegated to X" row plus a
 * detached card. A delegate's blocks whose parent isn't in this segment fall
 * back to a standalone `agent-group`.
 *
 * Main-agent blocks (no sub-agent producer) and non-tool blocks keep their
 * original position. With no producers and no delegate resolver (sub-graph
 * streaming off) this is an identity transform.
 */
export function partitionWorkflowBlocksBySubagent(
  blocks: AssistantWorkflowBlock[],
  resolveProducer: (block: AssistantWorkflowBlock) => ToolProducer | undefined,
  resolveDelegate?: (
    block: AssistantWorkflowBlock,
  ) => DelegateBlockInfo | undefined,
): WorkflowRenderItem[] {
  // Pass 1: index sub-agent children by their parent task id (regardless of
  // stream order), and record which task ids have a parent `task` block present
  // in this segment so their children fold into the delegate item.
  const childrenByTask = new Map<string, WorkflowBlockEntry[]>();
  const subagentTypeByTask = new Map<string, string>();
  const delegateParentByIndex = new Map<number, string>();
  const delegateTaskIds = new Set<string>();

  blocks.forEach((block, index) => {
    if (block.type !== "tool") {
      return;
    }
    const delegate = resolveDelegate?.(block);
    if (delegate?.taskCallId) {
      delegateParentByIndex.set(index, delegate.taskCallId);
      delegateTaskIds.add(delegate.taskCallId);
      return;
    }
    const producer = resolveProducer(block);
    if (producer?.kind === "subagent" && producer.taskCallId) {
      const list = childrenByTask.get(producer.taskCallId) ?? [];
      list.push({ block, index });
      childrenByTask.set(producer.taskCallId, list);
      if (producer.subagentType && !subagentTypeByTask.has(producer.taskCallId)) {
        subagentTypeByTask.set(producer.taskCallId, producer.subagentType);
      }
    }
  });

  // Pass 2: emit items in original order. A delegate parent emits the combined
  // `delegate` item; its children are skipped where they land (folded above).
  // Orphan children (no parent block here) emit one `agent-group` at first hit.
  const items: WorkflowRenderItem[] = [];
  const emittedDelegate = new Set<string>();
  const emittedOrphanGroup = new Set<string>();

  blocks.forEach((block, index) => {
    const delegateTaskId = delegateParentByIndex.get(index);
    if (delegateTaskId) {
      if (emittedDelegate.has(delegateTaskId)) {
        return;
      }
      emittedDelegate.add(delegateTaskId);
      const subagentType = subagentTypeByTask.get(delegateTaskId);
      items.push({
        kind: "delegate",
        key: `delegate:${delegateTaskId}`,
        taskCallId: delegateTaskId,
        taskBlock: { block, index },
        ...(subagentType ? { subagentType } : {}),
        entries: childrenByTask.get(delegateTaskId) ?? [],
      });
      return;
    }

    const producer = block.type === "tool" ? resolveProducer(block) : undefined;
    if (producer?.kind === "subagent" && producer.taskCallId) {
      const taskCallId = producer.taskCallId;
      if (delegateTaskIds.has(taskCallId)) {
        return; // folded into the delegate item at the parent block's position
      }
      if (emittedOrphanGroup.has(taskCallId)) {
        return;
      }
      emittedOrphanGroup.add(taskCallId);
      const subagentType = subagentTypeByTask.get(taskCallId);
      items.push({
        kind: "agent-group",
        key: `agent:${taskCallId}`,
        taskCallId,
        ...(subagentType ? { subagentType } : {}),
        entries: childrenByTask.get(taskCallId) ?? [],
      });
      return;
    }

    items.push({ kind: "block", block, index });
  });

  return items;
}

/** Display name for a delegate's Agent card header. */
export function subagentDisplayName(subagentType?: string): string {
  const trimmed = subagentType?.trim();
  if (!trimmed) {
    return "Sub-agent";
  }
  // "general-purpose" → "General purpose"; keep already-spaced names intact.
  const spaced = trimmed.replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
