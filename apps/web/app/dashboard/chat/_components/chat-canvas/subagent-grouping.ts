import type { AssistantWorkflowBlock } from "./assistant-render-segments";
import type { ToolProducer } from "./types";

/**
 * One rendered unit inside a workflow segment: either a standalone block (the
 * main agent's tool call, reasoning, etc.) or a group of a single `task`
 * delegate's tool blocks that the UI wraps in one Agent card.
 */
export type WorkflowRenderItem =
  | { kind: "block"; block: AssistantWorkflowBlock; index: number }
  | {
      kind: "agent-group";
      key: string;
      taskCallId: string;
      subagentType?: string;
      entries: { block: AssistantWorkflowBlock; index: number }[];
    };

/**
 * Partition a workflow segment's blocks so every sub-agent's tool calls collapse
 * into one Agent card, keyed by the parent `task` call id.
 *
 * Grouping is by id, not adjacency: parallel delegates interleave their tool
 * events on the stream, so a delegate's blocks are gathered wherever they land
 * and the group is anchored at the delegate's first block. Main-agent blocks
 * (no sub-agent producer) and non-tool blocks keep their original position and
 * render exactly as before — so with sub-graph streaming off (no producer on any
 * block) this is an identity transform.
 */
export function partitionWorkflowBlocksBySubagent(
  blocks: AssistantWorkflowBlock[],
  resolveProducer: (block: AssistantWorkflowBlock) => ToolProducer | undefined,
): WorkflowRenderItem[] {
  const items: WorkflowRenderItem[] = [];
  const groupByTask = new Map<
    string,
    Extract<WorkflowRenderItem, { kind: "agent-group" }>
  >();

  blocks.forEach((block, index) => {
    const producer = block.type === "tool" ? resolveProducer(block) : undefined;
    if (producer?.kind === "subagent" && producer.taskCallId) {
      const existing = groupByTask.get(producer.taskCallId);
      if (existing) {
        existing.entries.push({ block, index });
        if (!existing.subagentType && producer.subagentType) {
          existing.subagentType = producer.subagentType;
        }
        return;
      }
      const group: Extract<WorkflowRenderItem, { kind: "agent-group" }> = {
        kind: "agent-group",
        key: `agent:${producer.taskCallId}`,
        taskCallId: producer.taskCallId,
        ...(producer.subagentType ? { subagentType: producer.subagentType } : {}),
        entries: [{ block, index }],
      };
      groupByTask.set(producer.taskCallId, group);
      items.push(group);
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
