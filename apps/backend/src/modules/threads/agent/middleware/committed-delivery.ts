import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getAgentToolDefinition } from "@sourceweft/agent-tool-registry";
import {
  readTerminalToolResult,
  type TerminalToolResult,
} from "@sourceweft/contracts/agent-tools";
import type { ToolCallTrace } from "../..";
import { collectToolOutputRecords } from "../turn/output-normalizer";

/**
 * Tool-calling decisions a working scope may still make after its latest
 * committed delivery. The next decision is its last normal one, after which
 * the existing bounded closing phase (and then finalizing) ends the run.
 */
export const COMMITTED_DELIVERY_TOOL_DECISION_LIMIT = 3;

const COMMITTED_DELIVERY_PROMPT = `Deliverable committed, finish now unless the user's request explicitly asked for a further deliverable or revision that is not yet published; in that case produce and publish only that, then finish. A host-verified publisher receipt in this turn confirms the published deliverable was delivered. Never re-verify, re-render or re-draft an already-published deliverable on your own, and do not update the todo list. The final reply summarizes what was published and only the checks completed before publishing.`;

/**
 * Bookkeeping tools withdrawn once this turn holds a committed delivery: a
 * decision spent on them only delays the final reply. Delivery tools stay
 * available for a further deliverable the user explicitly requested.
 */
export const COMMITTED_DELIVERY_BLOCKED_TOOL_NAMES: ReadonlySet<string> =
  new Set(["write_todos"]);

export type CommittedDelivery = {
  result: TerminalToolResult;
  /** Tool-calling model decisions after the latest newly committed version. */
  toolDecisionsSince: number;
};

/** Host tool output of a message; plain tool text is never result authority. */
export function readToolMessageResult(
  message: ToolMessage,
): Record<string, unknown> | null {
  const record = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const artifact = record(message.artifact);
  if (artifact) return artifact;
  if (typeof message.content !== "string" || message.content.length > 32_000)
    return null;
  try {
    return record(JSON.parse(message.content));
  } catch {
    return null;
  }
}

/** The committed artifact a tool message proves under its tool's contract. */
export function readCommittedToolMessage(
  message: BaseMessage,
): TerminalToolResult | null {
  if (!ToolMessage.isInstance(message) || message.status === "error")
    return null;
  const definition = getAgentToolDefinition(message.name ?? "");
  return definition?.terminalResult
    ? readTerminalToolResult(
        definition.terminalResult,
        readToolMessageResult(message),
      )
    : null;
}

/** The committed artifact a traced tool call proves under its tool's contract. */
export function readCommittedToolCall(
  call: ToolCallTrace,
): TerminalToolResult | null {
  if (call.status !== "completed" || call.error) return null;
  const spec = getAgentToolDefinition(call.tool)?.terminalResult;
  if (!spec) return null;
  for (const record of collectToolOutputRecords(call.output)) {
    const result = readTerminalToolResult(spec, record);
    if (result) return result;
  }
  return null;
}

/**
 * Derived from the scope's own current-turn messages, so checkpoints, resumes
 * and child graphs need no extra state. A receipt for an already-seen version (an
 * idempotent republish) does not restart the count; a new revision does.
 */
export function readCommittedDelivery(
  messages: readonly BaseMessage[],
): CommittedDelivery | null {
  // The root checkpoint holds the whole thread: only this turn's receipts
  // count, so a new request is never told an earlier delivery finished it.
  // Summarization and image replay rewrite only the model request, never the
  // state's HumanMessages; HITL and askUser resumes add none.
  let start = messages.length;
  while (start > 0 && !HumanMessage.isInstance(messages[start - 1])) start--;
  const seen = new Set<string>();
  let latest: { index: number; result: TerminalToolResult } | null = null;
  for (const [index, message] of messages.entries()) {
    if (index < start) continue;
    const result = readCommittedToolMessage(message);
    if (!result) continue;
    const version = JSON.stringify([
      result.artifactId,
      result.artifactVersionId,
    ]);
    if (seen.has(version)) continue;
    seen.add(version);
    latest = { index, result };
  }
  if (!latest) return null;
  const { index, result } = latest;
  return {
    result,
    toolDecisionsSince: messages
      .slice(index + 1)
      .filter(
        (message) =>
          AIMessage.isInstance(message) &&
          Boolean(
            message.tool_calls?.length || message.invalid_tool_calls?.length,
          ),
      ).length,
  };
}

export function isCommittedDeliveryExhausted(
  delivery: CommittedDelivery | null,
): boolean {
  return Boolean(
    delivery &&
    delivery.toolDecisionsSince >= COMMITTED_DELIVERY_TOOL_DECISION_LIMIT,
  );
}

/**
 * In closing the closing allowance is the only bound, so its remaining count is
 * reported; in working, the decisions left before the scope is moved into it.
 */
export function committedDeliveryPrompt(
  delivery: CommittedDelivery,
  closingDecisionsLeft: number | null,
): string {
  return closingDecisionsLeft === null
    ? `${COMMITTED_DELIVERY_PROMPT} Further tool-calling decisions before this run is moved into bounded closing: ${Math.max(
        0,
        COMMITTED_DELIVERY_TOOL_DECISION_LIMIT - delivery.toolDecisionsSince,
      )}`
    : `${COMMITTED_DELIVERY_PROMPT} Remaining closing decisions (including this one): ${closingDecisionsLeft}`;
}
