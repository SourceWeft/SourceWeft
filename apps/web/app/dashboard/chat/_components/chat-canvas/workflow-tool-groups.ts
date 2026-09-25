import { isDeliverableToolName } from "./artifact-progress";
import type { WorkflowBlockEntry, WorkflowRenderItem } from "./subagent-grouping";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
import type { ToolCallRecord, ToolConfirmationResolution } from "./types";
import { isUserQuestionTool } from "./user-question-display";

/** A run of main-agent tool calls folded under one summary row. */
export type WorkflowToolGroupItem = {
  entries: WorkflowBlockEntry[];
  key: string;
  kind: "tool-group";
};

export type WorkflowDisplayItem = WorkflowRenderItem | WorkflowToolGroupItem;

/** A group needs at least this many tool calls; one call renders as itself. */
const MIN_GROUP_TOOL_CALLS = 2;

/**
 * Fold consecutive main-agent tool calls into summary groups.
 *
 * Reasoning between two grouped calls joins the group; reasoning before the
 * first or after the last call stays outside, so the turn's opening and
 * closing thoughts remain visible. Anything the caller marks standalone
 * (pending approvals, questions to the user, artifact builders) and every
 * delegate or non-tool block ends the run and renders on its own.
 */
export function groupWorkflowToolRuns(
  items: WorkflowRenderItem[],
  isGroupableTool: (entry: WorkflowBlockEntry) => boolean,
): WorkflowDisplayItem[] {
  const result: WorkflowDisplayItem[] = [];
  let run: WorkflowBlockEntry[] = [];

  const isToolEntry = (entry: WorkflowBlockEntry) =>
    entry.block.type === "tool";

  const flush = () => {
    const firstTool = run.findIndex(isToolEntry);
    const lastTool = run.length - 1 - [...run].reverse().findIndex(isToolEntry);
    const core = firstTool === -1 ? [] : run.slice(firstTool, lastTool + 1);
    const toolCount = core.filter(isToolEntry).length;

    const emitEntries = (entries: WorkflowBlockEntry[]) => {
      for (const entry of entries) {
        result.push({ kind: "block", ...entry });
      }
    };

    if (toolCount < MIN_GROUP_TOOL_CALLS) {
      emitEntries(run);
    } else {
      emitEntries(run.slice(0, firstTool));
      result.push({
        entries: core,
        key: `tool-group:${core[0]?.block.id ?? ""}`,
        kind: "tool-group",
      });
      emitEntries(run.slice(lastTool + 1));
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind === "block") {
      const entry = { block: item.block, index: item.index };
      if (
        item.block.type === "reasoning" ||
        (item.block.type === "tool" && isGroupableTool(entry))
      ) {
        run.push(entry);
        continue;
      }
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}

/**
 * Whether a tool call may fold into a summary group. Calls that need the
 * user (an unanswered approval, a question) or that build a deliverable with
 * its own progress card always stay visible.
 */
export function isGroupableToolCall(
  toolCall: ToolCallRecord,
  resolvedConfirmations: readonly ToolConfirmationResolution[] = [],
) {
  if (isUserQuestionTool(toolCall.tool) || isDeliverableToolName(toolCall.tool)) {
    return false;
  }
  if (toolCall.status !== "approval_requested") {
    return true;
  }
  const confirmation = getToolConfirmationOutput(toolCall.output);
  return Boolean(
    confirmation &&
      resolvedConfirmations.some(
        (resolution) => resolution.confirmationId === confirmation.id,
      ),
  );
}
